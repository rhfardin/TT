// Bridges a Twilio Media Stream (phone audio, 8 kHz mu-law) to the OpenAI Realtime API.
import WebSocket, { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getLead, logEvent } from './db.js';
import { renderPrompt, firstGreeting } from './prompt.js';
import { streamToken, hangUp } from './twilio.js';
import { sendDemoLink, markDoNotCall } from './tools.js';
import { recordCallResult, OUTCOMES } from './results.js';

const TOOLS = [
  {
    type: 'function',
    name: 'send_demo_link',
    description: 'Send the redesigned website preview link (plus booking/payment links) to the business right now.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address the person confirmed. Leave empty to use the one on file.' },
        contact_name: { type: 'string', description: 'Name of the person to address the message to.' },
        channel: { type: 'string', enum: ['email', 'sms', 'both'], description: 'How to send it. sms texts the number we called.' },
      },
      required: ['channel'],
    },
  },
  {
    type: 'function',
    name: 'mark_do_not_call',
    description: 'Use when the person asks not to be called again or to be removed from the list.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Use after saying goodbye, or immediately on voicemail, phone menus or wrong numbers.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['finished', 'voicemail', 'wrong_number', 'not_interested', 'other'] } },
    },
  },
];

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function attachOpenAIBridge(server) {
  const wss = new WebSocketServer({ server, path: '/media-stream' });
  wss.on('connection', (twilioWs) => new CallSession(twilioWs));
}

class CallSession {
  constructor(twilioWs) {
    this.twilio = twilioWs;
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

    twilioWs.on('message', (raw) => this.onTwilio(raw));
    twilioWs.on('close', () => this.finish());
    twilioWs.on('error', (e) => console.error('twilio ws error', e.message));
  }

  onTwilio(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.event) {
      case 'start': return this.onStart(msg.start);
      case 'media':
        this.latestMediaTs = Number(msg.media.timestamp);
        if (this.openai?.readyState === WebSocket.OPEN) {
          this.sendOpenAI({ type: 'input_audio_buffer.append', audio: msg.media.payload });
        }
        return;
      case 'mark':
        this.markQueue.shift();
        if (msg.mark?.name === 'hangup') this.hangup();
        return;
      case 'stop': return this.twilio.close();
    }
  }

  onStart(start) {
    const p = start.customParameters || {};
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    this.callId = Number(p.callId);
    if (!this.callId || !safeEqual(p.token || '', streamToken(this.callId))) {
      console.warn('media stream rejected: bad token');
      return this.twilio.close();
    }
    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(this.callId);
    this.lead = call && getLead(call.lead_id);
    if (!this.lead) return this.twilio.close();
    db.prepare(`UPDATE calls SET status = 'in_progress', call_sid = ? WHERE id = ?`).run(this.callSid, this.callId);
    this.connectOpenAI();
  }

  connectOpenAI() {
    const { apiKey, realtimeModel, voice } = config.openai;
    this.openai = new WebSocket(`${config.openai.realtimeUrl}?model=${encodeURIComponent(realtimeModel)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.openai.on('open', () => {
      this.sendOpenAI({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: realtimeModel,
          output_modalities: ['audio'],
          instructions: renderPrompt(this.lead),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: { type: 'server_vad', silence_duration_ms: 500, create_response: true, interrupt_response: true },
            },
            output: { format: { type: 'audio/pcmu' }, voice },
          },
          tools: TOOLS,
          tool_choice: 'auto',
        },
      });
      // People usually answer with "Hello?" first. If they stay silent, open the call ourselves.
      this.greetTimer = setTimeout(() => {
        if (!this.userSpoke) this.sendOpenAI({ type: 'response.create', response: { instructions: `Say exactly: "${firstGreeting(this.lead)}"` } });
      }, 3500);
    });
    this.openai.on('message', (raw) => this.onOpenAI(raw));
    this.openai.on('close', () => this.twilio.readyState === WebSocket.OPEN && this.twilio.close());
    this.openai.on('error', (e) => {
      console.error('openai ws error', e.message);
      logEvent(this.lead?.id, 'openai_error', e.message);
    });
  }

  sendOpenAI(obj) {
    if (this.openai?.readyState === WebSocket.OPEN) this.openai.send(JSON.stringify(obj));
  }

  sendTwilio(obj) {
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({ streamSid: this.streamSid, ...obj }));
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
        console.error('openai error event', ev.error);
        logEvent(this.lead?.id, 'openai_error', ev.error?.message || ev.error);
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
          result = await sendDemoLink({ ...args, lead_id: this.lead.id });
        } else if (fc.name === 'mark_do_not_call') {
          result = markDoNotCall({ ...args, lead_id: this.lead.id });
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
    try { await hangUp(this.callSid); } catch (err) { console.error('hangup failed', err.message); }
  }

  async finish() {
    if (this.finished || !this.callId || !this.lead) return;
    this.finished = true;
    clearTimeout(this.greetTimer);
    if (this.openai?.readyState === WebSocket.OPEN) this.openai.close();
    const duration = this.elapsed();
    let analysis = {};
    try {
      analysis = await analyzeCall(this.lead, this.transcript, this.endReason);
    } catch (err) {
      console.error('analysis failed', err.message);
      logEvent(this.lead.id, 'analysis_failed', err.message);
    }
    recordCallResult(this.callId, {
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

async function analyzeCall(lead, transcript, endReason) {
  if (!transcript.some((t) => t.role === 'user')) {
    return { outcome: endReason === 'voicemail' ? 'voicemail' : 'no_answer', summary: 'Nobody spoke on the call.' };
  }
  const text = transcript.map((t) => `${t.role === 'agent' ? 'AI' : 'THEM'}: ${t.message}`).join('\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openai.analysisModel,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You review sales calls offering a website redesign to ${lead.business_name}. Reply with JSON only: ` +
            `{"outcome": one of ${JSON.stringify(OUTCOMES)}, "summary": "2-3 sentences for the salesperson", ` +
            '"meeting_time": "agreed follow-up time or empty", "email": "email they gave or empty", ' +
            '"decision_maker_name": "owner/decision maker name or empty", "next_step": "what the salesperson should do next"}. ' +
            'Use "link_sent" if they agreed to receive the preview, "sold" only if they clearly agreed to buy.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return JSON.parse(body.choices[0].message.content);
}
