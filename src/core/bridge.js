// Bridges a Twilio Media Stream (phone audio, 8 kHz mu-law) to the OpenAI Realtime API.
// Platform-free: the Node server and the Cloudflare Durable Object plug in their own sockets.
//
// io = {
//   sendTwilio(text), closeTwilio(),
//   connectOpenAI(url, apiKey, { onMessage(text), onClose(), onError(err) }) -> Promise<{ send(text), close(), isOpen() }>
// }
import { renderPrompt, firstGreeting, REALTIME_TOOLS } from './agent.js';
import { streamToken, hangUp } from './twilio.js';
import { sendDemoLink, markDoNotCall, recordCallResult, analyzeCall } from './actions.js';
import { safeEqual } from './crypto.js';

export class CallBridge {
  constructor(ctx, promptTemplate, io) {
    this.ctx = ctx;
    this.config = ctx.config;
    this.promptTemplate = promptTemplate;
    this.io = io;
    this.openai = null;
    this.streamSid = null;
    this.callSid = null;
    this.callId = null;
    this.lead = null;
    this.transcript = [];
    this.startedAt = Date.now();
    this.latestMediaTs = 0;
    this.responseStartTs = null;
    this.lastAssistantItem = null;
    this.markQueue = [];
    this.userSpoke = false;
    this.hangupRequested = false;
    this.finished = false;
  }

  async onTwilioMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.event) {
      case 'start': return this.onStart(msg.start);
      case 'media':
        this.latestMediaTs = Number(msg.media.timestamp);
        this.sendOpenAI({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        return;
      case 'mark':
        this.markQueue.shift();
        if (msg.mark?.name === 'hangup') await this.hangup();
        return;
      case 'stop': return this.io.closeTwilio();
    }
  }

  async onStart(start) {
    const p = start.customParameters || {};
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    const callId = Number(p.callId);
    if (!callId || !safeEqual(p.token, await streamToken(this.config.twilio, callId))) {
      console.warn('media stream rejected: bad token');
      return this.io.closeTwilio();
    }
    const call = await this.ctx.store.getCall(callId);
    const lead = call && (await this.ctx.store.getLead(call.lead_id));
    if (!lead) return this.io.closeTwilio();
    this.callId = callId;
    this.lead = lead;
    await this.ctx.store.updateCall(callId, { status: 'in_progress', call_sid: this.callSid });
    await this.connectOpenAI();
  }

  async connectOpenAI() {
    const { apiKey, realtimeUrl, realtimeModel, voice } = this.config.openai;
    try {
      this.openai = await this.io.connectOpenAI(`${realtimeUrl}?model=${encodeURIComponent(realtimeModel)}`, apiKey, {
        onMessage: (text) => this.onOpenAI(text),
        onClose: () => this.io.closeTwilio(),
        onError: (err) => this.logError(err),
      });
    } catch (err) {
      this.logError(err);
      return this.io.closeTwilio();
    }
    this.sendOpenAI({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: realtimeModel,
        output_modalities: ['audio'],
        instructions: renderPrompt(this.promptTemplate, this.lead, this.config.seller),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            // semantic_vad waits until the person has actually finished their thought, instead of
            // jumping in after a fixed pause, which is a big part of sounding human.
            turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
          },
          output: { format: { type: 'audio/pcmu' }, voice },
        },
        tools: REALTIME_TOOLS,
        tool_choice: 'auto',
      },
    });
    // People usually answer with "Hello?" first. If they stay silent, open the call ourselves.
    this.greetTimer = setTimeout(() => {
      if (!this.userSpoke) {
        this.sendOpenAI({ type: 'response.create', response: { instructions: `Say, warmly and casually: "${firstGreeting(this.lead)}"` } });
      }
    }, 3500);
  }

  logError(err) {
    const message = err?.message || String(err);
    console.error('openai error', message);
    this.ctx.store.logEvent(this.lead?.id, 'openai_error', message).catch(() => {});
  }

  sendOpenAI(obj) {
    if (this.openai?.isOpen()) this.openai.send(JSON.stringify(obj));
  }

  sendTwilio(obj) {
    this.io.sendTwilio(JSON.stringify({ streamSid: this.streamSid, ...obj }));
  }

  onOpenAI(raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.sendTwilio({ event: 'media', media: { payload: ev.delta } });
        if (this.responseStartTs === null) this.responseStartTs = this.latestMediaTs;
        if (ev.item_id) this.lastAssistantItem = ev.item_id;
        this.sendTwilio({ event: 'mark', mark: { name: 'chunk' } });
        this.markQueue.push('chunk');
        break;
      case 'input_audio_buffer.speech_started':
        this.userSpoke = true;
        clearTimeout(this.greetTimer);
        this.interrupt();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) this.transcript.push({ role: 'user', message: ev.transcript.trim(), t: this.elapsed() });
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript?.trim()) this.transcript.push({ role: 'agent', message: ev.transcript.trim(), t: this.elapsed() });
        break;
      case 'response.done':
        this.responseStartTs = null;
        this.handleFunctionCalls(ev.response?.output ?? []);
        break;
      case 'error':
        this.logError(ev.error?.message || JSON.stringify(ev.error));
        break;
    }
  }

  // The caller started talking over the agent: stop playback and trim what the model thinks was said.
  interrupt() {
    if (!this.markQueue.length || this.responseStartTs === null) return;
    const audioEndMs = Math.max(0, this.latestMediaTs - this.responseStartTs);
    if (this.lastAssistantItem) {
      this.sendOpenAI({ type: 'conversation.item.truncate', item_id: this.lastAssistantItem, content_index: 0, audio_end_ms: audioEndMs });
    }
    this.sendTwilio({ event: 'clear' });
    this.markQueue = [];
    this.lastAssistantItem = null;
    this.responseStartTs = null;
  }

  async handleFunctionCalls(output) {
    const calls = output.filter((o) => o.type === 'function_call');
    if (!calls.length) return;
    let needsResponse = false;
    for (const fc of calls) {
      let args = {};
      try { args = JSON.parse(fc.arguments || '{}'); } catch {}
      let result;
      try {
        if (fc.name === 'send_demo_link') {
          result = await sendDemoLink(this.ctx, { ...args, lead_id: this.lead.id });
        } else if (fc.name === 'mark_do_not_call') {
          result = await markDoNotCall(this.ctx, { ...args, lead_id: this.lead.id });
        } else if (fc.name === 'end_call') {
          this.endReason = args.reason;
          // Hang up once everything already sent to Twilio has finished playing.
          this.sendTwilio({ event: 'mark', mark: { name: 'hangup' } });
          this.markQueue.push('hangup');
          setTimeout(() => this.hangup(), 8000);
          result = { ok: true };
        } else {
          result = { ok: false, message: 'unknown tool' };
        }
      } catch (err) {
        result = { ok: false, message: err.message };
      }
      this.sendOpenAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(result) } });
      if (fc.name !== 'end_call') needsResponse = true;
    }
    if (needsResponse) this.sendOpenAI({ type: 'response.create' });
  }

  elapsed() {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  async hangup() {
    if (this.hangupRequested || !this.callSid) return;
    this.hangupRequested = true;
    try { await hangUp(this.config.twilio, this.callSid); } catch (err) { console.error('hangup failed', err.message); }
  }

  // Call this when the Twilio socket closes. Saves the transcript and the analysed outcome.
  async finish() {
    if (this.finished || !this.callId || !this.lead) return;
    this.finished = true;
    clearTimeout(this.greetTimer);
    if (this.openai?.isOpen()) this.openai.close();
    const duration = this.elapsed();
    let analysis = {};
    try {
      analysis = await analyzeCall(this.config, this.lead, this.transcript, this.endReason);
    } catch (err) {
      console.error('analysis failed', err.message);
      await this.ctx.store.logEvent(this.lead.id, 'analysis_failed', err.message);
    }
    await recordCallResult(this.ctx, this.callId, {
      summary: analysis.summary ?? null,
      transcript: this.transcript,
      outcome: analysis.outcome ?? (this.endReason === 'voicemail' ? 'voicemail' : null),
      collected: {
        meeting_time: analysis.meeting_time || null,
        email: analysis.email || null,
        decision_maker_name: analysis.decision_maker_name || null,
        next_step: analysis.next_step || null,
      },
      duration,
    });
  }
}
