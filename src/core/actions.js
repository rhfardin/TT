// Everything that happens around a call, shared by the Node server and the Cloudflare Worker.
// ctx = { config, store, sendEmail?(to, subject, text) }
import {
  checkLead, canCallNow, nextWindowStart, normalizePhone, leadTimezone, FINAL_STATUSES, zonedDate, localNowText, localTimeInfo, noCallReason,
} from './leads.js';
import { calcomReady, getSlots, book, spokenTime } from './calcom.js';
import { hotReason, notifyOwner, scheduleFollowup } from './notify.js';
import { estimateCostCents } from './costs.js';
import { promptVariables, followUpMessage, OUTCOME_STATUS, OUTCOMES } from './agent.js';
import { createStreamingCall, sendSms, hangUp, updateCall, transferTwiml, whisperTwiml, streamTwiml } from './twilio.js';
import { hmacHex, safeEqual } from './crypto.js';

export function providerProblem(config) {
  if (config.voiceProvider === 'elevenlabs') {
    const el = config.elevenlabs;
    return el.apiKey && el.agentId && el.phoneNumberId
      ? null : 'ElevenLabs is not configured (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID).';
  }
  const tw = config.twilio;
  if (!(config.openai.apiKey && tw.accountSid && tw.authToken && tw.fromNumber)) {
    return 'OpenAI calling is not configured (OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).';
  }
  // Twilio has to reach this server over the internet, or the business answers to silence.
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(config.publicUrl);
  if ((!config.publicUrl.startsWith('https://') || local) && !config.allowLocalUrl) {
    return `Your site address must be a public https:// address so Twilio can reach it (it's ${config.publicUrl}). Set PUBLIC_URL.`;
  }
  return null;
}

async function startElevenLabsCall(config, lead) {
  const el = config.elevenlabs;
  const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: { 'xi-api-key': el.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: el.agentId,
      agent_phone_number_id: el.phoneNumberId,
      to_number: lead.phone,
      call_recording_enabled: config.recordCalls,
      conversation_initiation_client_data: { dynamic_variables: promptVariables(lead, config.seller) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const d = body?.detail;
    throw new Error((typeof d === 'object' ? d?.message || JSON.stringify(d) : d) || body?.message || `HTTP ${res.status}`);
  }
  return { conversationId: body.conversation_id ?? null, callSid: body.callSid ?? null };
}

export async function placeCall(ctx, leadId, opts = {}) {
  const { config, store } = ctx;
  const lead = await store.getLead(leadId);
  // resetTries: a manual "Call now" may go past the max-tries limit (the count restarts only if it goes out).
  const check = checkLead(lead && opts.resetTries ? { ...lead, attempts: 0 } : lead, config.calling, opts);
  if (!check.ok) return { ok: false, error: check.reason };
  const problem = providerProblem(config);
  if (problem) return { ok: false, error: problem };
  if (await store.isDnc(lead.phone)) {
    await store.updateLead(lead.id, { status: 'dnc' });
    return { ok: false, error: 'this number is on your do-not-call list' };
  }
  if (await store.hasLiveInboundCall(lead.id)) return { ok: false, error: 'they are on a call with us right now' };
  if (config.calling.paused && !lead.is_test) return { ok: false, error: 'calling is paused (turn it back on with Resume)', limited: true };
  const limit = config.calling.dailySpendLimitCents;
  if (limit && !lead.is_test && (await store.spendLast24h()) >= limit) {
    return { ok: false, error: `daily spend limit reached ($${(limit / 100).toFixed(2)} in 24 hours)`, limited: true };
  }
  if (!lead.is_test && (await store.callsLast24h()).count >= config.calling.maxCallsPerDay) {
    return { ok: false, error: `daily limit reached (${config.calling.maxCallsPerDay} calls in 24 hours), to protect your number from spam labels`, limited: true };
  }
  // Atomic, so a manual call and the queue can never ring the same business twice.
  if (!(await store.claimLeadForCall(lead.id, config.calling.maxAttempts, { resetTries: opts.resetTries }))) {
    return { ok: false, error: 'this business is already being called' };
  }
  const callId = await store.insertCall(lead.id);
  // Script version: campaigns can test a second script (B) against the main one (A).
  const campaign = opts.campaignId ? await store.getCampaign(opts.campaignId) : null;
  const variant = campaign?.variant_mode === 'B' ? 'B' : campaign?.variant_mode === 'AB' ? (lead.id % 2 ? 'B' : 'A') : 'A';
  await store.updateCall(callId, { campaign_id: campaign?.id ?? null, variant });
  try {
    let conversationId = null;
    let callSid;
    if (config.voiceProvider === 'elevenlabs') {
      ({ conversationId, callSid } = await startElevenLabsCall(config, lead));
    } else {
      callSid = (await createStreamingCall(config, { to: lead.phone, callId })).sid;
    }
    await store.updateCall(callId, { conversation_id: conversationId, call_sid: callSid ?? null, status: 'ringing' });
    await store.logEvent(lead.id, 'call_started', { provider: config.voiceProvider, callSid });
    return { ok: true, callId };
  } catch (err) {
    await store.updateCall(callId, { status: 'failed', error: err.message });
    await store.updateLead(lead.id, { status: 'failed' });
    await store.logEvent(lead.id, 'call_failed', err.message);
    return { ok: false, error: err.message };
  }
}

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// usage: OpenAI token usage for the call (see costs.js); extraSeconds: the owner's leg of a live transfer.
export async function recordCallResult(ctx, callId, { summary, transcript, outcome, collected = {}, duration, usage = null, extraSeconds = 0 }) {
  const { store, config } = ctx;
  const call = await store.getCall(callId);
  if (!call) return;
  // Exactly once per call, even when the bridge, voicemail detection and Twilio's callbacks race.
  if (!(await store.claimCallCompletion(callId))) return;
  const lead = await store.getLead(call.lead_id);
  outcome = String(outcome ?? '').toLowerCase().trim();
  const inbound = call.direction === 'inbound';
  const talked = (transcript ?? []).some((t) => t.role === 'user');
  usage ??= call.usage ? JSON.parse(call.usage) : {};
  const costCents = callCostCents(config, { usage, duration, inbound, extraSeconds });

  await store.updateCall(callId, {
    status: 'completed', duration_secs: duration ?? null, summary: summary ?? null, ended_at: nowSql(),
    transcript: JSON.stringify(transcript ?? []), outcome: JSON.stringify({ outcome, ...collected }),
    talked: talked ? 1 : 0, usage: JSON.stringify(usage), cost_cents: costCents,
  });

  const fields = { last_summary: summary ?? null };
  // A "do not call" set by a tool during the call wins over anything else. A caller who hung up
  // straight away doesn't change anything, and a call from a customer who already said yes (or no)
  // only ever moves them up: a "won" business stays won.
  if (lead.status !== 'dnc' && (talked || !inbound)) {
    const next = OUTCOME_STATUS[outcome] ?? (talked ? 'completed' : 'no_answer');
    const keep = inbound && (lead.status === 'won' || (lead.status === 'not_interested' && !['interested', 'won', 'callback'].includes(next)));
    if (!keep) fields.status = next;
  }
  if (collected.business_name && lead.business_name === UNKNOWN_CALLER) fields.business_name = String(collected.business_name).slice(0, 200);
  // A call-back time the AI booked during the call is more exact than the summary's version.
  const callbackSet = await store.callbackSetSince(lead.id, call.created_at);
  if (collected.meeting_time && !callbackSet) fields.meeting_time = String(collected.meeting_time);
  if (collected.email && !lead.email) fields.email = String(collected.email);
  if (collected.decision_maker_name && !lead.contact_name) fields.contact_name = String(collected.decision_maker_name);
  await store.updateLead(lead.id, fields);
  await store.logEvent(lead.id, 'call_completed', { outcome, duration, direction: call.direction });
  const reason = hotReason({ status: fields.status, outcome, inbound, talked });
  if (reason && !lead.is_test) await notifyOwner(ctx, { ...lead, ...fields }, { reason, summary, collected });
  const unreached = fields.status === 'no_answer' || fields.status === 'voicemail';
  // Reached (on any call, theirs or ours): a retry call already waiting for them would be one too many.
  if (talked || (!inbound && !unreached)) await store.dequeueLead(lead.id, call.created_at);
  else if (!inbound && unreached) await scheduleRetry(ctx, lead.id, fields.status);
  // They gave a time to call back but the AI didn't book it during the call: book it now.
  if (collected.callback_at && fields.status !== 'dnc' && !callbackSet && !lead.is_test) {
    const r = await scheduleCallback(ctx, { lead_id: lead.id, when: collected.callback_at, note: 'from the call summary' });
    if (!r.ok) await store.logEvent(lead.id, 'callback_not_set', `${collected.callback_at}: ${r.message}`);
  }
}

// ---- Calling back at a time the business picks ----

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// when: "YYYY-MM-DD HH:MM" on the business's clock. Allowed 8 am to 8 pm their time on a calling day,
// up to 60 days ahead. The queue then calls at exactly that time.
export async function scheduleCallback(ctx, { lead_id, when, note = '' }, now = new Date()) {
  const { store, config } = ctx;
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'lead not found' };
  if (String(lead.phone).startsWith('hidden:')) return { ok: false, message: 'Their number is hidden, so we can\'t call them back. Ask for their number and say the owner will call.' };
  const m = String(when || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return { ok: false, message: 'Give the time as YYYY-MM-DD HH:MM (24-hour clock, their local time).' };
  const [hour, minute] = [Number(m[2]), Number(m[3])];
  const tz = leadTimezone(lead, config.calling);
  const at = zonedDate(m[1], hour, minute, tz);
  if (!Number.isFinite(at.getTime()) || minute > 59) return { ok: false, message: 'That isn\'t a real date and time.' };
  if (at.getTime() < now.getTime() + 5 * 60 * 1000) return { ok: false, message: `That time has passed. It's ${localNowText(tz, now)} for them.` };
  if (at.getTime() > now.getTime() + 60 * 864e5) return { ok: false, message: 'That\'s too far ahead. Offer a time in the next few weeks.' };
  if (hour < 8 || hour >= 20) return { ok: false, message: 'Callbacks are only between 8 am and 8 pm their time. Suggest a time in that range.' };
  const day = localTimeInfo(tz, at).day;
  if (!config.calling.days.includes(day)) {
    return { ok: false, message: `There are no calls on ${DAY_NAMES[day]}s. Suggest ${config.calling.days.map((d) => DAY_NAMES[d]).join(', ')}.` };
  }
  const blocked = noCallReason(config.calling, m[1]);
  if (blocked) return { ok: false, message: `${blocked} Suggest another day.` };
  await store.scheduleCallback(lead.id, at.toISOString());
  const spoken = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
  await store.updateLead(lead.id, { meeting_time: `Call back ${spoken} (their time)${note ? ` · ${String(note).slice(0, 200)}` : ''}` });
  await store.logEvent(lead.id, 'callback_scheduled', `${at.toISOString()}${note ? ` ${note}` : ''}`);
  await ctx.queue?.poke?.();
  return { ok: true, message: `Done: we'll call back ${spoken}, their time. Confirm it back to them briefly.` };
}

// ---- Pressing keys in a phone menu (OpenAI provider) ----

// Twilio media streams can't send key presses, so the call briefly leaves the stream: Twilio plays the
// digits, then connects a fresh stream (resume=keys) and the AI carries on with the conversation so far.
export async function pressKeys(ctx, callId, { callSid, digits, transcript, usage }) {
  const { store, config } = ctx;
  if (!(await store.claimCallStatus(callId, 'in_progress', 'pressing_keys'))) return { ok: false, message: 'The call isn\'t connected.' };
  await store.updateCall(callId, { transcript: JSON.stringify(transcript ?? []), usage: JSON.stringify(usage ?? {}) });
  try {
    await updateCall(config.twilio, callSid, await streamTwiml(config, callId, { resume: 'keys', digits }));
  } catch (err) {
    await store.updateCall(callId, { status: 'in_progress' });
    return { ok: false, message: 'The keys could not be pressed. Try saying the option out loud, or wait for an operator.' };
  }
  const call = await store.getCall(callId);
  await store.logEvent(call.lead_id, 'pressed_keys', digits).catch(() => {});
  return { ok: true };
}

// The call ended while switching back from a key press (the stream never reconnected): save what we have.
async function finishPausedCall(ctx, call, duration) {
  const transcript = JSON.parse(call.transcript || '[]');
  const lead = await ctx.store.getLead(call.lead_id);
  let analysis = {};
  try { analysis = (await analyzeCall(ctx.config, lead, transcript)) ?? {}; } catch (err) { await ctx.store.logEvent(lead.id, 'analysis_failed', err.message); }
  await recordCallResult(ctx, call.id, {
    summary: analysis.summary ?? 'The call ended in the business\'s phone menu.', transcript,
    outcome: analysis.outcome ?? 'no_answer', collected: collectedFrom(analysis), duration,
  });
}

// The fields the after-call analysis may fill in, as saved with the call.
export const collectedFrom = (a) => ({
  meeting_time: a.meeting_time || null, email: a.email || null, decision_maker_name: a.decision_maker_name || null,
  next_step: a.next_step || null, requests: a.requests || null, business_name: a.business_name || null,
  callback_at: /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(String(a.callback_at || '').trim()) ? String(a.callback_at).trim() : null,
});

// Estimated cost of a call in cents (see costs.js).
function callCostCents(config, { usage, duration, inbound, extraSeconds = 0 }) {
  const seconds = Number(duration) || 0;
  if (config.voiceProvider === 'elevenlabs') {
    return Math.round(Math.ceil(seconds / 60) * 10.4 * 100) / 100; // ElevenLabs ~$0.09 + Twilio ~$0.014 per minute
  }
  return estimateCostCents({
    model: config.openai.realtimeModel, usage, seconds, answered: seconds > 0 || extraSeconds > 0, inbound,
    amd: config.calling.amdEnabled, recorded: config.recordCalls, extraSeconds,
  });
}

export const isMachine = (answeredBy) => /^(machine|fax)/.test(String(answeredBy || ''));

export const recordVoicemail = (ctx, callId, duration = null, usage = null) => recordCallResult(ctx, callId, {
  summary: 'Reached voicemail or an answering machine; hung up without leaving a message.',
  transcript: [], outcome: 'voicemail', duration, usage,
});

// Businesses in the call list get called again later, at a different time of day each try.
export async function scheduleRetry(ctx, leadId, reason) {
  const { store, config } = ctx;
  const lead = await store.getLead(leadId);
  if (!lead?.in_campaign || lead.is_test || FINAL_STATUSES.includes(lead.status)) return;
  if (lead.attempts >= config.calling.maxAttempts) return;
  // A campaign that was stopped (or paused and then stopped) doesn't get new calls.
  if (lead.campaign_id && (await store.getCampaign(lead.campaign_id))?.status === 'stopped') return;
  const hours = reason === 'voicemail' ? config.calling.retryVoicemailHours : config.calling.retryNoAnswerHours;
  const shift = lead.attempts % 2 ? 3 : -2;
  const at = nextWindowStart(lead, config.calling, new Date(Date.now() + Math.max(hours / 2, hours + shift) * 3600 * 1000));
  await store.scheduleLead(lead.id, at.toISOString(), `retry after ${reason}`, lead.campaign_id ?? null);
  await store.logEvent(lead.id, 'retry_scheduled', at.toISOString());
  await ctx.queue?.poke?.();
}

// status: 'no_answer' (didn't pick up, busy) or 'failed' (something broke).
export async function recordNotConnected(ctx, callId, reason, status = 'no_answer') {
  const { store } = ctx;
  const call = await store.getCall(callId);
  if (!call || call.status === 'completed') return;
  await store.updateCall(callId, { status, error: String(reason), ended_at: nowSql(), talked: 0, cost_cents: 0 });
  const lead = await store.getLead(call.lead_id);
  if (lead?.status === 'calling') await store.updateLead(lead.id, { status: 'no_answer' });
  await store.logEvent(call.lead_id, 'call_not_connected', reason);
  if (status === 'no_answer' && lead?.status === 'calling') await scheduleRetry(ctx, call.lead_id, 'no_answer');
}

// Twilio's call status callback (OpenAI provider).
export async function handleTwilioStatus(ctx, callId, params) {
  const status = params.CallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) {
    await recordNotConnected(ctx, callId, status, status === 'failed' ? 'failed' : 'no_answer');
  } else if (status === 'completed') {
    const call = await ctx.store.getCall(callId);
    if (!call) return;
    if (['initiated', 'ringing'].includes(call.status) && !isMachine(call.answered_by)) {
      if (call.direction === 'inbound') {
        await recordNotConnected(ctx, callId, 'they hung up before the AI answered');
      } else {
        // Answered, but our audio stream never connected (wrong PUBLIC_URL, proxy without websockets...).
        await recordNotConnected(ctx, callId, 'the call was answered but the AI audio never connected; check PUBLIC_URL', 'failed');
      }
    } else if (call.status === 'pressing_keys') {
      await finishPausedCall(ctx, call, Number(params.CallDuration) || null);
    } else if (call.status === 'transferring') {
      // The call ended during or after a transfer without the Dial result arriving first.
      await finalizeTransfer(ctx, callId, { duration: Number(params.CallDuration) || null });
    } else if (call.status === 'completed' && !call.duration_secs && Number(params.CallDuration) > 0) {
      // Recorded before the call ended (voicemail detection): add the length and its cost now.
      const seconds = Number(params.CallDuration);
      const usage = JSON.parse(call.usage || '{}');
      await ctx.store.updateCall(callId, {
        duration_secs: seconds,
        cost_cents: callCostCents(ctx.config, { usage, duration: seconds, inbound: call.direction === 'inbound' }),
      });
    }
  }
}

// Status callback for calls to our number (set by "Set it up for me"): find the call by its Twilio id.
export async function handleTwilioInboundStatus(ctx, _callId, params) {
  const call = params.CallSid ? await ctx.store.getCallBySid(params.CallSid) : null;
  if (call) await handleTwilioStatus(ctx, call.id, params);
}

// Runs work after Twilio has been answered (it gives up on webhooks that take over 15 seconds).
export function inBackground(ctx, promise) {
  const p = promise.catch((err) => console.error('background work failed', err));
  if (ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

// ---- Incoming calls (OpenAI provider) ----

export const UNKNOWN_CALLER = 'Unknown caller';
// What Twilio puts in "From" for anonymous, restricted, blocked and unavailable caller IDs.
const HIDDEN_CALLER_IDS = ['+266696687', '+7378742833', '+2562533', '+8656696', '+86282452253'];

// Twilio asks what to do with a call to our number: find who's calling and connect the AI.
export async function handleTwilioInbound(ctx, _callId, params) {
  const { store, config } = ctx;
  if (!params.CallSid || providerProblem(config)) {
    return `<Response><Say>Sorry, nobody can take your call right now. Please try again later.</Say><Hangup/></Response>`;
  }
  // Hidden numbers still get answered; they just can't be matched to a business. Twilio sends
  // withheld caller IDs as fixed pseudo-numbers, which must never merge different callers into one lead.
  const from = normalizePhone(params.From, config.calling.defaultCountryCode);
  const phone = from && !HIDDEN_CALLER_IDS.includes(from) ? from : `hidden:${params.CallSid}`;
  let lead = await store.getLeadByPhone(phone);
  if (!lead) {
    await store.upsertLeads([{
      phone, business_name: UNKNOWN_CALLER, contact_name: null, email: null, website: null, demo_link: null,
      category: null, city: null, timezone: null, notes: 'Called our number; not in the sheet.', extra: '{}',
    }]);
    lead = await store.getLeadByPhone(phone);
  }
  const callId = await store.insertInboundCall(lead.id, params.CallSid);
  await store.logEvent(lead.id, 'inbound_call', params.From || 'hidden number');
  return streamTwiml(config, callId);
}

// ---- Live transfer to the owner (OpenAI provider) ----

// The owner can take live calls: switched on, phone set, and inside this business's calling hours.
export function transferAvailable(config, lead) {
  return Boolean(config.transfer.enabled && config.transfer.phone && config.twilio.fromNumber && canCallNow(lead, config.calling).ok);
}

// Saves the conversation so far and hands the call over to the owner's phone.
export async function startTransfer(ctx, callId, { callSid, summary, transcript }) {
  const { store, config } = ctx;
  await store.updateCall(callId, {
    status: 'transferring', transfer_state: 'ringing', transfer_summary: String(summary || '').slice(0, 300),
    transcript: JSON.stringify(transcript ?? []),
  });
  try {
    // The call's time limit was set for the AI part; the owner's conversation gets up to 4 hours.
    await updateCall(config.twilio, callSid, transferTwiml(config, callId), { TimeLimit: '14400' });
  } catch (err) {
    await store.updateCall(callId, { status: 'in_progress', transfer_state: 'failed' });
    return { ok: false, message: `The transfer didn't go through. Apologize and offer that ${config.seller.yourName || 'the owner'} calls them back today.` };
  }
  const call = await store.getCall(callId);
  await store.logEvent(call.lead_id, 'transfer_started', summary).catch(() => {});
  return { ok: true };
}

// TwiML played to the owner before he's connected.
export async function handleTwilioWhisper(ctx, callId) {
  const call = await ctx.store.getCall(callId);
  const lead = call && (await ctx.store.getLead(call.lead_id));
  if (!lead) return '<Response><Hangup/></Response>';
  return whisperTwiml(ctx.config, callId, `Live transfer from your AI caller. ${lead.business_name}. ${call.transfer_summary || ''}`);
}

export async function handleTwilioWhisperAnswer(ctx, callId, params) {
  const accepted = params.Digits === '1';
  await ctx.store.updateCall(callId, { transfer_state: accepted ? 'connected' : 'declined' });
  return accepted ? '<Response/>' : '<Response><Hangup/></Response>'; // empty response = connect the two calls
}

// The owner's leg of the call ended: either they talked, or he didn't take it and the AI picks it back up.
export async function handleTwilioTransferResult(ctx, callId, params) {
  const call = await ctx.store.getCall(callId);
  if (!call || call.status !== 'transferring') return '<Response><Hangup/></Response>';
  if (call.transfer_state === 'connected') {
    // Answer Twilio right away; the analysis and alert email can take longer than Twilio waits.
    inBackground(ctx, finalizeTransfer(ctx, callId, { talkSecs: Number(params.DialCallDuration) || 0 }));
    return '<Response><Hangup/></Response>';
  }
  await ctx.store.updateCall(callId, { transfer_state: 'missed' });
  await ctx.store.logEvent(call.lead_id, 'transfer_missed', params.DialCallStatus || call.transfer_state);
  return streamTwiml(ctx.config, callId, { resume: true });
}

// Records the result of a call that was handed over to the owner. Runs once per call.
export async function finalizeTransfer(ctx, callId, { talkSecs = null, duration = null } = {}) {
  const { store, config } = ctx;
  if (!(await store.claimCallStatus(callId, 'transferring', 'finalizing'))) return;
  const call = await store.getCall(callId);
  const lead = await store.getLead(call.lead_id);
  const transcript = JSON.parse(call.transcript || '[]');
  let analysis = {};
  try {
    analysis = (await analyzeCall(config, lead, transcript)) ?? {};
  } catch (err) {
    await store.logEvent(lead.id, 'analysis_failed', err.message);
  }
  const name = config.seller.yourName || 'you';
  const connected = call.transfer_state === 'connected';
  duration ??= Math.max(0, Math.round((Date.now() - Date.parse(`${call.created_at.replace(' ', 'T')}Z`)) / 1000)) || null;
  const lead_in = connected
    ? `Connected to ${name}${talkSecs ? ` for ${Math.max(1, Math.round(talkSecs / 60))} min` : ''}.`
    : `They hung up while being connected to ${name}.`;
  await recordCallResult(ctx, callId, {
    summary: `${lead_in} ${analysis.summary || ''}`.trim(),
    transcript,
    outcome: connected ? 'transferred' : analysis.outcome || 'callback',
    collected: {
      meeting_time: analysis.meeting_time || null,
      email: analysis.email || null,
      decision_maker_name: analysis.decision_maker_name || null,
      next_step: connected ? analysis.next_step || null : `Call them back: they wanted to talk to ${name}.`,
      requests: analysis.requests || null,
      business_name: analysis.business_name || null,
      talk_secs: talkSecs,
    },
    duration,
    extraSeconds: talkSecs || 0,
  });
}

// Twilio's answering machine detection result (OpenAI provider).
export async function handleTwilioAmd(ctx, callId, params) {
  const call = await ctx.store.getCall(callId);
  if (!call) return;
  await ctx.store.updateCall(callId, { answered_by: params.AnsweredBy || 'unknown' });
  if (!isMachine(params.AnsweredBy)) return;
  try {
    await hangUp(ctx.config.twilio, call.call_sid || params.CallSid);
  } catch (err) {
    await ctx.store.logEvent(call.lead_id, 'hangup_failed', err.message);
  }
  // If the AI audio never started, record it here; otherwise the bridge does when the stream closes.
  if (['initiated', 'ringing'].includes(call.status)) await recordVoicemail(ctx, callId);
}

export async function handleTwilioRecording(ctx, callId, params) {
  if (params.RecordingSid && params.RecordingStatus === 'completed') {
    await ctx.store.updateCall(callId, { recording_sid: params.RecordingSid });
  }
}

// ---- Things the AI can do during the call ----

// Only these arguments are used; the texted number is always the business's own number.
export async function sendDemoLink(ctx, { lead_id, email, contact_name, channel }) {
  const { config, store } = ctx;
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Could not find that business in the system.' };
  if (!lead.demo_link) {
    await store.logEvent(lead.id, 'demo_link_missing', 'no redesign link in the sheet');
    return { ok: false, message: `There is no preview link on file for this business. Tell them ${config.seller.yourName || 'the team'} will email it personally today.` };
  }
  email = typeof email === 'string' ? email.trim() : '';
  const sent = [];
  const text = followUpMessage(lead, contact_name || lead.contact_name, config.seller);

  const to = (email || lead.email || '').trim();
  if (channel !== 'sms' && to && ctx.sendEmail) {
    try {
      await ctx.sendEmail(to, `Your new website preview - ${lead.business_name}`, text);
      sent.push(`email to ${to}`);
      if (email && email !== lead.email) await store.updateLead(lead.id, { email });
      await scheduleFollowup(ctx, lead);
    } catch (err) {
      await store.logEvent(lead.id, 'email_failed', err.message);
    }
  }

  const tw = config.twilio;
  if (channel === 'sms' || channel === 'both') {
    const toPhone = lead.phone;
    if (tw.accountSid && tw.authToken && tw.fromNumber && /^\+\d+$/.test(toPhone)) { // not for hidden numbers
      try {
        await sendSms(tw, toPhone, text);
        sent.push(`text to ${toPhone}`);
      } catch (err) {
        await store.logEvent(lead.id, 'sms_failed', err.message);
      }
    }
  }

  await store.logEvent(lead.id, 'demo_link_sent', { sent, requested: { email, channel } });
  if (!sent.length) {
    return { ok: false, message: 'The link could not be sent automatically. Tell them the team will send it over shortly.' };
  }
  return { ok: true, message: `Sent the link by ${sent.join(' and ')}.` };
}

// ---- Booking a call with the owner (Cal.com) ----

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// A handful of open times in the business's timezone: the first two of the next three days that have any.
export async function checkAvailability(ctx, { lead_id, day }) {
  const { config, store } = ctx;
  const name = config.seller.yourName || 'the owner';
  if (!calcomReady(config.calcom)) return { ok: false, message: `Booking isn't set up. Offer that ${name} calls them back, and get a good time.` };
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Unknown business.' };
  const timeZone = leadTimezone(lead, config.calling);
  let from = new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    const d = new Date(`${day}T00:00:00Z`);
    if (d > from) from = d;
  }
  let slots;
  try {
    slots = await getSlots(config.calcom, { timeZone, from, days: day ? 2 : 7 });
  } catch (err) {
    await store.logEvent(lead.id, 'calcom_error', err.message);
    return { ok: false, message: `The calendar couldn't be checked. Offer that ${name} calls them back, and get a good time.` };
  }
  const soon = Date.now() + 30 * 60 * 1000;
  const perDay = new Map();
  for (const s of slots) {
    if (Date.parse(s) < soon) continue;
    const key = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(s));
    if (!perDay.has(key)) perDay.set(key, []);
    if (perDay.get(key).length < 2) perDay.get(key).push(s);
  }
  const picked = [...perDay.values()].slice(0, 3).flat();
  if (!picked.length) return { ok: false, message: `No open times soon. Offer that ${name} calls them back, and get a good time.` };
  return {
    ok: true,
    times: picked.map((s) => ({ start: s, say: spokenTime(s, timeZone) })),
    message: 'Offer two or three of these naturally, in their time. When they pick one, confirm their email, then call book_meeting with that exact start.',
  };
}

export async function bookMeeting(ctx, { lead_id, start, name, email }) {
  const { config, store } = ctx;
  const owner = config.seller.yourName || 'the owner';
  if (!calcomReady(config.calcom)) return { ok: false, message: `Booking isn't set up. Offer that ${owner} calls them back.` };
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Unknown business.' };
  email = String(email || lead.email || '').trim();
  if (!isEmail(email)) return { ok: false, message: 'Ask for their email (spell it back to confirm), then try book_meeting again.' };
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return { ok: false, message: 'Use one of the exact start times from check_availability.' };
  const startIso = at.toISOString();
  const timeZone = leadTimezone(lead, config.calling);
  try {
    // Book only times the calendar really has open right now (the model might misremember one).
    const open = await getSlots(config.calcom, { timeZone, from: new Date(at.getTime() - 60 * 1000), days: 1 });
    if (!open.includes(startIso)) {
      return { ok: false, message: 'That time isn\'t open any more. Call check_availability again and offer other times.' };
    }
    const r = await book(config.calcom, {
      start: startIso, email, timeZone, phone: /^\+/.test(lead.phone) ? lead.phone : null,
      name: String(name || lead.contact_name || lead.business_name).slice(0, 100),
      notes: `${lead.business_name}: website redesign call, booked by the AI caller.`,
    });
    const say = spokenTime(startIso, timeZone);
    await store.updateLead(lead.id, { meeting_time: say, ...(lead.email ? {} : { email }) });
    await store.logEvent(lead.id, 'meeting_booked', { start: startIso, uid: r.uid });
    return { ok: true, message: `Booked for ${say}, their time. Cal.com emails them the invite. Confirm the day and time back to them.` };
  } catch (err) {
    await store.logEvent(lead.id, 'calcom_error', err.message);
    return { ok: false, message: `The booking didn't go through. Apologize, and offer that ${owner} calls them back at that time instead.` };
  }
}

export async function markDoNotCall(ctx, { lead_id, reason }) {
  const lead = await ctx.store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Unknown business.' };
  // A test call is the owner trying things out: never block his own number.
  if (lead.is_test) return { ok: true, message: 'This is a test call, so nothing was changed. Apologize briefly and end the call politely.' };
  await ctx.store.updateLead(lead.id, { status: 'dnc' });
  if (!String(lead.phone).startsWith('hidden:')) await ctx.store.addDnc([lead.phone], 'asked on a call');
  await ctx.store.logEvent(lead.id, 'do_not_call', reason || 'requested on call');
  return { ok: true, message: 'They have been removed from the call list. Apologize briefly and end the call politely.' };
}

// ---- After-call analysis (OpenAI provider) ----

export async function analyzeCall(config, lead, transcript, endReason) {
  const tz = leadTimezone(lead, config.calling);
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
            '"decision_maker_name": "owner/decision maker name or empty", "next_step": "what the salesperson should do next", ' +
            '"requests": "changes they want, questions the AI could not answer, and anything promised to them, or empty", ' +
            '"business_name": "the caller\'s business name if they said it, or empty", ' +
            '"callback_at": "if they asked to be called back at a particular day and time, that time as YYYY-MM-DD HH:MM ' +
            `(24-hour, their local time; it was ${localNowText(tz)} for them during the call), else empty"}. ` +
            'Use "link_sent" if they agreed to receive the preview, "sold" only if they clearly agreed to buy.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const parsed = JSON.parse(body.choices?.[0]?.message?.content || 'null');
  return parsed && typeof parsed === 'object' ? parsed : {};
}

// ---- ElevenLabs post-call webhook ----

// Header "ElevenLabs-Signature: t=<unix>,v0=<hex>", hex = HMAC-SHA256(secret, `${t}.${rawBody}`).
export async function verifyElevenLabsSignature(config, rawBody, header) {
  const secret = config.elevenlabs.webhookSecret;
  // Without a secret anyone could post fake call results, so the webhook is closed until one is set.
  if (config.voiceProvider !== 'elevenlabs' || !secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v0 || Math.abs(Date.now() / 1000 - t) > 30 * 60) return false;
  return safeEqual(await hmacHex(secret, `${t}.${rawBody}`), parts.v0);
}

const val = (results, key) => {
  const r = results?.[key];
  const v = r && typeof r === 'object' && 'value' in r ? r.value : r;
  return v === undefined || v === null || v === '' ? null : v;
};

export async function handleElevenLabsWebhook(ctx, payload) {
  const { store } = ctx;
  const type = payload?.type;
  const data = payload?.data ?? {};
  const convId = data.conversation_id;
  const dyn = data.conversation_initiation_client_data?.dynamic_variables ?? {};

  let call = convId ? await store.getCallByConversation(convId) : null;
  if (!call && dyn.lead_id && (await store.getLead(dyn.lead_id))) {
    call = { id: await store.insertCall(dyn.lead_id, convId ?? null) };
  }
  if (!call) {
    await store.logEvent(null, 'webhook_unmatched', { type, convId });
    return;
  }

  if (type === 'call_initiation_failure') {
    await recordNotConnected(ctx, call.id, data.failure_reason || data.reason || 'call failed');
    return;
  }
  if (type !== 'post_call_transcription') return; // e.g. post_call_audio is ignored

  const analysis = data.analysis ?? {};
  const results = analysis.data_collection_results ?? {};
  await recordCallResult(ctx, call.id, {
    summary: analysis.transcript_summary ?? null,
    transcript: (data.transcript ?? [])
      .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'user', message: t.message, t: t.time_in_call_secs }))
      .filter((t) => t.message),
    outcome: val(results, 'outcome'),
    collected: Object.fromEntries(Object.keys(results).map((k) => [k, val(results, k)])),
    duration: data.metadata?.call_duration_secs ?? null,
  });
}
