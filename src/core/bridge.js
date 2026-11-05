// Bridges a Twilio Media Stream (phone audio, 8 kHz mu-law) to the OpenAI Realtime API.
// Platform-free: the Node server and the Cloudflare Durable Object plug in their own sockets.
//
// io = {
//   sendTwilio(text), closeTwilio(),
//   connectOpenAI(url, apiKey, { onMessage(text), onClose(), onError(err) }) -> Promise<{ send(text), close(), isOpen() }>
// }
// Every public method catches its own errors: a failing call must never crash the server.
import { renderPrompt, firstGreeting, realtimeTools } from './agent.js';
import { streamToken, hangUp } from './twilio.js';
import {
  sendDemoLink, markDoNotCall, recordCallResult, recordVoicemail, analyzeCall, isMachine, transferAvailable, startTransfer,
  UNKNOWN_CALLER, checkAvailability, bookMeeting, scheduleCallback, pressKeys, collectedFrom,
} from './actions.js';
import { leadTimezone, localNowText } from './leads.js';
import { calcomReady } from './calcom.js';
import { addUsage } from './costs.js';
import { safeEqual } from './crypto.js';

// Duration of a base64 chunk of 8 kHz mu-law audio (1 byte per sample).
const audioMs = (b64) => ((b64.length * 3) / 4 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0)) / 8;

// With voicemail detection on, the AI waits this long before it may speak, so an answering machine
// is usually hung up on before the AI says a word. A person saying "Hello?" just hears a short pause.
const AMD_GUARD_MS = 2000;

const turnDetection = (createResponse) =>
  // semantic_vad waits until the person has actually finished their thought, instead of
  // jumping in after a fixed pause, which is a big part of sounding human.
  ({ type: 'semantic_vad', eagerness: 'auto', create_response: createResponse, interrupt_response: true });

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
    this.usage = {}; // OpenAI tokens used, for the cost estimate
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      Promise.resolve().then(fn).catch((err) => this.logError(err));
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
          // Twilio confirms marks in order once the audio before them has played. After a "clear"
          // (the caller talked over the AI) it also echoes the cleared marks; those are ignored.
          const i = this.marks.indexOf(msg.mark?.name);
          if (i < 0) return;
          this.marks.splice(0, i + 1);
          if (msg.mark.name === 'hangup') await this.hangup();
          if (msg.mark.name === 'transfer') await this.doTransfer();
          if (msg.mark.name === 'keys') await this.doPressKeys();
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
    // resume: the AI picks the call back up: '1' after a transfer the owner didn't take, 'keys' after
    // pressing keys in the business's phone menu.
    const resume = p.resume === '1' || p.resume === 'keys' ? p.resume : null;
    const expectedStatus = resume === '1' ? call?.status === 'transferring' && call.transfer_state === 'missed'
      : resume === 'keys' ? call?.status === 'pressing_keys' : ['initiated', 'ringing'].includes(call?.status);
    const fresh = call && expectedStatus && (!call.call_sid || call.call_sid === start.callSid);
    const lead = fresh && (await this.ctx.store.getLead(call.lead_id));
    if (!lead) {
      console.warn('media stream rejected');
      return this.io.closeTwilio();
    }
    // Only from the status we just checked, so a stream can't take over a call that moved on meanwhile.
    if (!(await this.ctx.store.claimCallStatus(callId, call.status, 'in_progress'))) {
      console.warn('media stream rejected: call already taken');
      return this.io.closeTwilio();
    }
    this.callId = callId;
    this.callSid = call.call_sid || start.callSid;
    this.lead = lead;
    this.resumed = resume;
    this.inbound = call.direction === 'inbound';
    this.variant = call.variant || 'A';
    if (resume) {
      this.transcript = JSON.parse(call.transcript || '[]');
      this.usage = JSON.parse(call.usage || '{}');
      this.startedAt = Date.parse(`${call.created_at.replace(' ', 'T')}Z`) || this.startedAt; // time limit counts the whole call
    }
    if (!call.call_sid) await this.ctx.store.updateCall(callId, { call_sid: this.callSid });
    // They hung up while we were getting ready: record the call now (finish() ran before we knew it).
    if (this.closed) return this.finish();
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
    // Voicemail detection only exists on calls we place; someone calling us is a person.
    const guard = this.config.calling.amdEnabled && !this.resumed && !this.inbound;
    const inbound = this.inbound && !this.resumed ? (this.lead.business_name === UNKNOWN_CALLER ? 'unknown' : 'known') : null;
    this.transferOk = this.resumed !== '1' && transferAvailable(this.config, this.lead);
    const transfer = this.resumed === '1' ? 'missed' : this.transferOk ? 'available' : 'unavailable';
    const booking = calcomReady(this.config.calcom);
    const callbacks = !String(this.lead.phone).startsWith('hidden:');
    const menus = !this.inbound;
    const keysPressed = this.resumed === 'keys' ? [...this.transcript].reverse().find((t) => t.keys)?.keys || 'a key' : null;
    this.sendOpenAI({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: realtimeModel,
        output_modalities: ['audio'],
        instructions: renderPrompt(this.template(), this.lead, this.config.seller, {
          // Calls to us aren't recorded.
          recording: this.config.recordCalls && !this.inbound, transfer, history: this.transcript, inbound, booking,
          callbacks, localNow: localNowText(leadTimezone(this.lead, this.config.calling)), menus, keysPressed,
        }),
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            noise_reduction: { type: 'near_field' }, // phone audio held close to the mouth
            turn_detection: turnDetection(!guard),
          },
          output: { format: { type: 'audio/pcmu' }, voice },
        },
        tools: realtimeTools({ transfer: this.transferOk, booking, callbacks, menus }),
        tool_choice: 'auto',
      },
    });
    if (guard) {
      this.guardActive = true;
      this.later(AMD_GUARD_MS, () => {
        this.guardActive = false;
        this.sendOpenAI({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: turnDetection(true) } } } });
        // They already said "Hello?" during the pause: answer it now.
        if (this.heardDuringGuard) this.sendOpenAI({ type: 'response.create' });
      });
    }
    if (this.resumed === 'keys') {
      // Back from a phone menu: listen first (more options, hold music or a person picking up).
    } else if (this.resumed || this.inbound) {
      this.sendOpenAI({ type: 'response.create' }); // they're waiting: answer / apologize right away (see the prompt)
    } else {
      // People usually answer with "Hello?" first. If they stay silent, open the call ourselves.
      this.greetTimer = this.later(3500, () => {
      if (!this.userSpoke) {
          this.sendOpenAI({ type: 'response.create', response: { instructions: `Say, warmly and casually: "${firstGreeting(this.lead)}"` } });
        }
      });
    }
    // Wrap up politely before the call's time limit, then hang up.
    const limitMs = this.config.calling.maxCallSeconds * 1000 - (Date.now() - this.startedAt);
    this.later(Math.max(limitMs - 30000, 10000), () => this.sendOpenAI({ type: 'response.create', response: {
      instructions: 'The call is almost out of time. Briefly wrap up: confirm the next step, say a warm goodbye, then call end_call.',
    } }));
    this.later(Math.max(limitMs - 3000, 15000), () => this.hangup());
    // Dead air: counted from after the opening on our calls, and with more patience while on hold.
    const silenceMs = this.config.calling.silenceSeconds * 1000;
    if (silenceMs > 0) {
      this.lastActivity = Date.now() + (this.resumed || this.inbound ? 0 : 3500);
      this.watchSilence(this.resumed === 'keys' ? silenceMs * 3 : silenceMs);
    }
  }

  // Nobody has said anything (and the AI isn't talking) for limitMs: say goodbye and hang up.
  // If they do answer, the call simply carries on.
  watchSilence(limitMs) {
    this.later(Math.min(2000, limitMs / 4), () => {
      if (this.closed || this.finished || this.hangupRequested) return;
      const busy = this.marks.length || this.userSpeaking || this.responding || this.guardActive || this.transferring || this.pressing;
      if (busy) this.lastActivity = Math.max(this.lastActivity, Date.now());
      else if (!this.silencePromptAt && Date.now() - this.lastActivity >= limitMs) {
        const promptedAt = (this.silencePromptAt = Date.now());
        this.endReason = 'silence';
        this.sendOpenAI({ type: 'response.create', response: { instructions: 'Nobody has said anything for a while; the line may be dead. ' +
          'Say only: "Hello? ... Seems like I lost you. I\'ll try you another time. Bye!", then call end_call with reason "other".' } });
        this.later(Math.min(15000, Math.max(3000, limitMs)), () => {
          if ((this.lastUserAt || 0) < promptedAt) return this.hangup();
          this.silencePromptAt = null; // they answered: carry on
          if (this.endReason === 'silence') this.endReason = null;
        });
      }
      this.watchSilence(limitMs);
    });
  }

  // The script for this call: the version picked when it was placed (A or B), edited in the dashboard,
  // or the built-in prompts/sales-agent.md.
  template() {
    const p = this.config.prompt;
    return (this.variant === 'B' && p.b) || p.a || this.promptTemplate;
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
      case 'input_audio_buffer.committed':
        if (this.guardActive) this.heardDuringGuard = true;
        break;
      case 'input_audio_buffer.speech_started':
        this.userSpoke = true;
        this.userSpeaking = true;
        this.lastUserAt = Date.now();
        clearTimeout(this.greetTimer);
        this.interrupt();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.lastActivity = Date.now();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript?.trim()) {
          this.addLine('user', ev.transcript);
          this.lastUserAt = this.lastActivity = Date.now();
        }
        break;
      case 'response.created':
        this.responding = true;
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (ev.transcript?.trim()) this.addLine('agent', ev.transcript);
        break;
      case 'response.done':
        this.responding = false;
        this.lastActivity = Date.now();
        this.usage = addUsage(this.usage, ev.response?.usage);
        this.handleFunctionCalls(ev.response?.output ?? []).catch((err) => this.logError(err));
        break;
      case 'error':
        this.logError(ev.error?.message || JSON.stringify(ev.error));
        break;
    }
  }

  // Adds a line and saves the transcript shortly after, so the dashboard can show the call live.
  addLine(role, text, extra = {}) {
    this.transcript.push({ role, message: text.trim(), t: this.elapsed(), ...extra });
    if (this.saveTimer) return;
    this.saveTimer = this.later(1500, () => {
      this.saveTimer = null;
      if (!this.closed && this.callId) {
        this.ctx.store.updateCall(this.callId, { transcript: JSON.stringify(this.transcript) }).catch(() => {});
      }
    });
  }

  playAudio(ev) {
    // Audio still arriving for a reply the caller already talked over is dropped.
    if (!ev.delta || this.truncated?.has(ev.item_id)) return;
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
    const playing = this.marks.some((m) => m !== 'hangup' && m !== 'transfer' && m !== 'keys');
    if (!playing || !this.item) return;
    const heardMs = Math.round(Math.min(Math.max(this.latestMediaTs - this.item.startTs, 0), this.item.sentMs));
    if (this.item.id) {
      this.sendOpenAI({ type: 'conversation.item.truncate', item_id: this.item.id, content_index: 0, audio_end_ms: heardMs });
      (this.truncated ??= new Set()).add(this.item.id);
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
        } else if (fc.name === 'check_availability') {
          result = await checkAvailability(this.ctx, { ...pick(args, ['day']), lead_id: this.lead.id });
        } else if (fc.name === 'book_meeting') {
          result = await bookMeeting(this.ctx, { ...pick(args, ['start', 'name', 'email']), lead_id: this.lead.id });
        } else if (fc.name === 'schedule_callback') {
          result = await scheduleCallback(this.ctx, { ...pick(args, ['when', 'note']), lead_id: this.lead.id });
        } else if (fc.name === 'press_keys') {
          const digits = String(args.digits ?? '').replace(/[\s,-]/g, '');
          const pressedBefore = this.transcript.filter((t) => t.keys).length;
          if (this.inbound || !/^[0-9*#]{1,10}$/.test(digits)) result = { ok: false, message: 'Keys must be 0-9, * or #.' };
          else if (pressedBefore >= 6) result = { ok: false, message: 'Too many menu presses on this call. If you can\'t reach a person, call end_call.' };
          else if (this.pressing || this.transferring) result = { ok: false, message: 'Already busy. Say nothing.' };
          else {
            // Pressed once anything the AI is still saying has played; no reply until the call reconnects.
            this.pressing = { callId: fc.call_id, digits };
            this.sendMark('keys');
            this.later(Math.max(0, this.playbackEnd - this.latestMediaTs) + 1500, () => this.doPressKeys());
            continue;
          }
        } else if (fc.name === 'transfer_to_fardin') {
          if (this.transferring) {
            // Asked twice while already connecting: answer quietly, no new reply.
            this.sendOpenAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: fc.call_id, output: '{"ok":true,"message":"Already connecting. Say nothing."}' } });
            continue;
          }
          if (this.transferOk) {
            // Connect once "one sec, let me grab him" has finished playing. No reply to the model:
            // its session ends when the call moves to the owner's phone.
            this.transferring = { callId: fc.call_id, summary: String(args.summary || '').slice(0, 300) };
            this.sendMark('transfer');
            this.later(Math.max(0, this.playbackEnd - this.latestMediaTs) + 3000, () => this.doTransfer());
            continue;
          }
          result = { ok: false, message: 'Live transfer is not available right now. Offer that he calls them back today, and get a good time.' };
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

  async doTransfer() {
    const t = this.transferring;
    if (!t || t.started || this.closed) return;
    t.started = true;
    // Marked before Twilio is asked, because the stream closes the moment the call moves over:
    // finish() then waits for this instead of recording the call as finished.
    this.endReason = 'transfer';
    t.promise = (async () => {
      await this.ctx.store.updateCall(this.callId, { usage: JSON.stringify(this.usage) }); // for the cost once it ends
      return startTransfer(this.ctx, this.callId, { callSid: this.callSid, summary: t.summary, transcript: this.transcript });
    })().catch((err) => ({ ok: false, message: err.message }));
    const r = await t.promise;
    if (r.ok) return;
    this.endReason = null;
    this.transferring = null;
    this.sendOpenAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: t.callId, output: JSON.stringify(r) } });
    this.sendOpenAI({ type: 'response.create' });
  }

  async doPressKeys() {
    const k = this.pressing;
    if (!k || k.started || this.closed) return;
    k.started = true;
    this.addLine('agent', `(pressed ${k.digits} in their phone menu)`, { keys: k.digits });
    const line = this.transcript.at(-1);
    this.endReason = 'keys'; // the stream closes as the call leaves it; finish() waits for this
    k.promise = pressKeys(this.ctx, this.callId, { callSid: this.callSid, digits: k.digits, transcript: this.transcript, usage: this.usage })
      .catch((err) => ({ ok: false, message: err.message }));
    const r = await k.promise;
    if (r.ok) return;
    this.transcript.splice(this.transcript.indexOf(line), 1);
    this.endReason = null;
    this.pressing = null;
    this.sendOpenAI({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: k.callId, output: JSON.stringify(r) } });
    this.sendOpenAI({ type: 'response.create' });
  }

  elapsed() {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  async hangup() {
    // Never hang up a call that's being handed to the owner.
    if (this.hangupRequested || !this.callSid || this.finished || this.transferring?.started || this.pressing?.started) return;
    this.hangupRequested = true;
    try {
      await hangUp(this.config.twilio, this.callSid);
    } catch (err) {
      this.hangupRequested = false; // let the time limit try again
      console.error('hangup failed', err.message);
    }
  }

  // Call this when the Twilio socket closes. Saves the transcript and the analysed outcome.
  async finish() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.openai?.isOpen()) this.openai.close();
    if (this.finished || !this.callId || !this.lead) return;
    if (this.transferring?.promise) {
      // The call continues on the owner's phone and is saved by finalizeTransfer, unless the transfer failed.
      const r = await this.transferring.promise;
      if (r.ok) {
        await this.ctx.store.updateCall(this.callId, { usage: JSON.stringify(this.usage) }).catch(() => {});
        return;
      }
    }
    if (this.pressing?.promise) {
      // The call continues on a new stream after the key press (that stream saves the result).
      const r = await this.pressing.promise;
      if (r.ok) {
        await this.ctx.store.updateCall(this.callId, { usage: JSON.stringify(this.usage), transcript: JSON.stringify(this.transcript) }).catch(() => {});
        return;
      }
    }
    if (this.finished) return;
    this.finished = true;
    try {
      const duration = this.elapsed();
      // Voicemail detection fired during the call: no need to analyse a greeting message.
      const call = await this.ctx.store.getCall(this.callId);
      if (isMachine(call?.answered_by)) return await recordVoicemail(this.ctx, this.callId, duration, this.usage);
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
        collected: collectedFrom(analysis),
        duration,
        usage: this.usage,
      });
    } catch (err) {
      this.logError(err);
    }
  }
}
