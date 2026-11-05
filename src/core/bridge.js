// Bridges a Twilio Media Stream (phone audio, 8 kHz mu-law) to the OpenAI Realtime API.
// Platform-free: the Node server and the Cloudflare Durable Object plug in their own sockets.
//
// io = {
//   sendTwilio(text), closeTwilio(),
//   connectOpenAI(url, apiKey, { onMessage(text), onClose(), onError(err) }) -> Promise<{ send(text), close(), isOpen() }>
// }
// Every public method catches its own errors: a failing call must never crash the server.
import { renderPrompt, firstGreeting, REALTIME_TOOLS } from './agent.js';
import { streamToken, hangUp } from './twilio.js';
import { sendDemoLink, markDoNotCall, recordCallResult, analyzeCall } from './actions.js';
import { safeEqual } from './crypto.js';

// Duration of a base64 chunk of 8 kHz mu-law audio (1 byte per sample).
const audioMs = (b64) => ((b64.length * 3) / 4 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)) / 8;

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

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
    this.timers = new Set();
    this.closed = false; // the phone side is gone
    this.finished = false; // results saved
    this.userSpoke = false;
    this.hangupRequested = false;
    // Playback tracking, in Twilio media-timestamp milliseconds.
    this.latestMediaTs = 0;
    this.playbackEnd = 0; // when everything sent so far will have finished playing
    this.marks = []; // marks sent to Twilio whose audio hasn't played yet
    this.markSeq = 0;
    this.item = null; // { id, startTs, sentMs } for the assistant item currently being played
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  async onTwilioMessage(raw) {
    try {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.event) {
        case 'start': return await this.onStart(msg.start || {});
        case 'media':
          this.latestMediaTs = Number(msg.media?.timestamp) || this.latestMediaTs;
          this.sendOpenAI({ type: 'input_audio_buffer.append', audio: msg.media?.payload });
          return;
        case 'mark': {
          // Twilio confirms marks in order once the audio before them has played.
          const i = this.marks.indexOf(msg.mark?.name);
          if (i >= 0) this.marks.splice(0, i + 1);
          if (msg.mark?.name === 'hangup') await this.hangup();
          return;
        }
        case 'stop': return this.io.closeTwilio();
      }
    } catch (err) {
      this.logError(err);
    }
  }

  async onStart(start) {
    const p = start.customParameters || {};
    this.streamSid = start.streamSid;
    const callId = Number(p.callId);
    let expected = null;
    try { expected = callId ? await streamToken(this.config.twilio, callId) : null; } catch { /* no Twilio auth token */ }
    const call = expected && safeEqual(p.token, expected) ? await this.ctx.store.getCall(callId) : null;
    // Only the call we just placed may connect, once: a replayed or stale stream is turned away.
    const fresh = call && ['initiated', 'ringing'].includes(call.status) && (!call.call_sid || call.call_sid === start.callSid);
    const lead = fresh && (await this.ctx.store.getLead(call.lead_id));
    if (!lead) {
      console.warn('media stream rejected');
      return this.io.closeTwilio();
    }
    this.callId = callId;
    this.callSid = call.call_sid || start.callSid;
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
    // The caller hung up while we were connecting: don't leave a paid AI session running.
    if (this.closed) return this.openai.close();
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
    this.greetTimer = this.later(3500, () => {
      if (!this.userSpoke) {
        this.sendOpenAI({ type: 'response.create', response: { instructions: `Say, warmly and casually: "${firstGreeting(this.lead)}"` } });
      }
    });
  }

  logError(err) {
    const message = err?.message || String(err);
    console.error('call error', message);
    this.ctx.store.logEvent(this.lead?.id, 'call_error', message).catch(() => {});
  }

  sendOpenAI(obj) {
    if (this.openai?.isOpen()) this.openai.send(JSON.stringify(obj));
  }

  sendTwilio(obj) {
    if (!this.closed) this.io.sendTwilio(JSON.stringify({ streamSid: this.streamSid, ...obj }));
  }

  sendMark(name) {
    this.marks.push(name);
    this.sendTwilio({ event: 'mark', mark: { name } });
  }

  onOpenAI(raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.playAudio(ev);
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
        this.handleFunctionCalls(ev.response?.output ?? []).catch((err) => this.logError(err));
        break;
      case 'error':
        this.logError(ev.error?.message || JSON.stringify(ev.error));
        break;
    }
  }

  playAudio(ev) {
    if (!ev.delta) return;
    const ms = audioMs(ev.delta);
    const now = this.latestMediaTs;
    if (!this.item || this.item.id !== ev.item_id) {
      // A new reply starts playing once whatever is still buffered has finished.
      this.item = { id: ev.item_id, startTs: Math.max(now, this.playbackEnd), sentMs: 0 };
    }
    this.item.sentMs += ms;
    this.playbackEnd = Math.max(now, this.playbackEnd) + ms;
    this.sendTwilio({ event: 'media', media: { payload: ev.delta } });
    this.sendMark(`a${++this.markSeq}`);
  }

  // The caller started talking over the agent: stop playback and tell the model how much they heard.
  interrupt() {
    const playing = this.marks.some((m) => m !== 'hangup');
    if (!playing || !this.item) return;
    const heardMs = Math.round(Math.min(Math.max(this.latestMediaTs - this.item.startTs, 0), this.item.sentMs));
    if (this.item.id) {
      this.sendOpenAI({ type: 'conversation.item.truncate', item_id: this.item.id, content_index: 0, audio_end_ms: heardMs });
    }
    this.sendTwilio({ event: 'clear' });
    this.marks = []; // Twilio still confirms the cleared marks; they're ignored now
    this.playbackEnd = this.latestMediaTs;
    this.item = null;
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
          result = await sendDemoLink(this.ctx, { ...pick(args, ['email', 'contact_name', 'channel']), lead_id: this.lead.id });
        } else if (fc.name === 'mark_do_not_call') {
          result = await markDoNotCall(this.ctx, { ...pick(args, ['reason']), lead_id: this.lead.id });
        } else if (fc.name === 'end_call') {
          this.endReason = String(args.reason || 'finished');
          // Hang up when Twilio says the goodbye has finished playing, with a timer in case it never does.
          this.sendMark('hangup');
          this.later(Math.max(0, this.playbackEnd - this.latestMediaTs) + 3000, () => this.hangup());
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
    if (this.hangupRequested || !this.callSid || this.finished) return;
    this.hangupRequested = true;
    try { await hangUp(this.config.twilio, this.callSid); } catch (err) { console.error('hangup failed', err.message); }
  }

  // Call this when the Twilio socket closes. Saves the transcript and the analysed outcome.
  async finish() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.openai?.isOpen()) this.openai.close();
    if (this.finished || !this.callId || !this.lead) return;
    this.finished = true;
    try {
      const duration = this.elapsed();
      let analysis = {};
      try {
        analysis = (await analyzeCall(this.config, this.lead, this.transcript, this.endReason)) ?? {};
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
          requests: analysis.requests || null,
        },
        duration,
      });
    } catch (err) {
      this.logError(err);
    }
  }
}
