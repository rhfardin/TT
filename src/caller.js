import { config } from './config.js';
import { db, getLead, updateLead, logEvent } from './db.js';
import { promptVariables } from './prompt.js';
import { createStreamingCall } from './twilio.js';

const DONT_CALL = new Set(['dnc', 'won', 'not_interested']);

export function localTimeInfo(timezone) {
  let tz = timezone || config.calling.defaultTimezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = config.calling.defaultTimezone;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const wd = parts.find((p) => p.type === 'weekday').value;
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
  return { tz, hour, day };
}

export function canCallNow(lead) {
  const { tz, hour, day } = localTimeInfo(lead.timezone);
  const c = config.calling;
  if (!c.days.includes(day)) return { ok: false, reason: `outside calling days in ${tz}` };
  if (hour < c.windowStartHour || hour >= c.windowEndHour) {
    return { ok: false, reason: `it is ${hour}:00 in ${tz}; calling window is ${c.windowStartHour}:00-${c.windowEndHour}:00` };
  }
  return { ok: true };
}

export function checkLead(lead, { ignoreWindow = false } = {}) {
  if (!lead) return { ok: false, reason: 'lead not found' };
  if (DONT_CALL.has(lead.status)) return { ok: false, reason: `status is ${lead.status}` };
  if (lead.status === 'calling') return { ok: false, reason: 'a call is already in progress' };
  if (lead.attempts >= config.calling.maxAttempts) return { ok: false, reason: `already tried ${lead.attempts} times` };
  if (!ignoreWindow) return canCallNow(lead);
  return { ok: true };
}

function providerReady() {
  if (config.voiceProvider === 'elevenlabs') {
    const el = config.elevenlabs;
    return el.apiKey && el.agentId && el.phoneNumberId
      ? null : 'ElevenLabs is not configured (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID).';
  }
  const tw = config.twilio;
  return config.openai.apiKey && tw.accountSid && tw.authToken && tw.fromNumber
    ? null : 'OpenAI calling is not configured (OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).';
}

async function startElevenLabsCall(lead) {
  const el = config.elevenlabs;
  const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: { 'xi-api-key': el.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: el.agentId,
      agent_phone_number_id: el.phoneNumberId,
      to_number: lead.phone,
      call_recording_enabled: config.recordCalls,
      conversation_initiation_client_data: { dynamic_variables: promptVariables(lead) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const d = body?.detail;
    throw new Error((typeof d === 'object' ? d?.message || JSON.stringify(d) : d) || body?.message || `HTTP ${res.status}`);
  }
  return { conversationId: body.conversation_id ?? null, callSid: body.callSid ?? null };
}

export async function placeCall(leadId, opts = {}) {
  const lead = getLead(leadId);
  const check = checkLead(lead, opts);
  if (!check.ok) return { ok: false, error: check.reason };
  const notReady = providerReady();
  if (notReady) return { ok: false, error: notReady };

  updateLead(lead.id, { status: 'calling', attempts: lead.attempts + 1, last_called_at: new Date().toISOString() });
  const callId = Number(db.prepare('INSERT INTO calls (lead_id) VALUES (?)').run(lead.id).lastInsertRowid);

  try {
    let conversationId = null;
    let callSid;
    if (config.voiceProvider === 'elevenlabs') {
      ({ conversationId, callSid } = await startElevenLabsCall(lead));
    } else {
      callSid = (await createStreamingCall({ to: lead.phone, callId })).sid;
    }
    db.prepare(`UPDATE calls SET conversation_id = ?, call_sid = ?, status = 'ringing' WHERE id = ?`)
      .run(conversationId, callSid ?? null, callId);
    logEvent(lead.id, 'call_started', { provider: config.voiceProvider, callSid });
    return { ok: true, callId };
  } catch (err) {
    db.prepare(`UPDATE calls SET status = 'failed', error = ? WHERE id = ?`).run(err.message, callId);
    updateLead(lead.id, { status: 'failed' });
    logEvent(lead.id, 'call_failed', err.message);
    return { ok: false, error: err.message };
  }
}

// A simple in-memory queue so a batch of calls goes out one at a time.
const queue = [];
let running = false;

export function enqueue(ids, opts = {}) {
  const results = [];
  for (const id of ids) {
    const lead = getLead(id);
    const check = checkLead(lead, { ignoreWindow: true });
    if (!check.ok) { results.push({ id, queued: false, reason: check.reason }); continue; }
    if (queue.some((q) => q.id === Number(id))) { results.push({ id, queued: false, reason: 'already queued' }); continue; }
    queue.push({ id: Number(id), opts });
    updateLead(id, { status: 'queued' });
    results.push({ id, queued: true });
  }
  run();
  return results;
}

export function queueState() {
  return { running, pending: queue.map((q) => q.id) };
}

export function clearQueue() {
  for (const q of queue.splice(0)) {
    const lead = getLead(q.id);
    if (lead?.status === 'queued') updateLead(q.id, { status: 'new' });
  }
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { id, opts } = queue.shift();
      const lead = getLead(id);
      if (lead?.status === 'queued') updateLead(id, { status: lead.attempts ? 'no_answer' : 'new' });
      const r = await placeCall(id, opts);
      if (!r.ok) {
        logEvent(id, 'queue_skip', r.error);
        continue;
      }
      if (queue.length) await new Promise((res) => setTimeout(res, config.calling.spacingSeconds * 1000));
    }
  } finally {
    running = false;
  }
}

// If the post-call webhook never arrives, don't leave a lead stuck in "calling".
setInterval(() => {
  db.prepare(`UPDATE leads SET status = 'no_answer'
              WHERE status = 'calling' AND last_called_at < ?`)
    .run(new Date(Date.now() - 30 * 60 * 1000).toISOString());
}, 5 * 60 * 1000).unref();
