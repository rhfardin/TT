import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getLead, logEvent } from './db.js';
import { recordCallResult, recordNotConnected } from './results.js';

// ElevenLabs signs post-call webhooks with header "ElevenLabs-Signature: t=<unix>,v0=<hex>"
// where hex = HMAC-SHA256(secret, `${t}.${rawBody}`).
export function verifySignature(rawBody, header) {
  const secret = config.elevenlabs.webhookSecret;
  if (!secret) return true; // not configured: accept (set the secret in production!)
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v0 || Math.abs(Date.now() / 1000 - t) > 30 * 60) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v0);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const val = (results, key) => {
  const r = results?.[key];
  const v = r && typeof r === 'object' && 'value' in r ? r.value : r;
  return v === undefined || v === null || v === '' ? null : v;
};

// ElevenLabs post-call webhook: "post_call_transcription" or "call_initiation_failure".
export function handlePostCall(payload) {
  const type = payload?.type;
  const data = payload?.data ?? {};
  const convId = data.conversation_id;
  const dyn = data.conversation_initiation_client_data?.dynamic_variables ?? {};

  let call = convId ? db.prepare('SELECT * FROM calls WHERE conversation_id = ?').get(convId) : null;
  if (!call && dyn.lead_id && getLead(dyn.lead_id)) {
    const r = db.prepare('INSERT INTO calls (lead_id, conversation_id) VALUES (?, ?)').run(Number(dyn.lead_id), convId ?? null);
    call = { id: Number(r.lastInsertRowid) };
  }
  if (!call) {
    logEvent(null, 'webhook_unmatched', { type, convId });
    return;
  }

  if (type === 'call_initiation_failure') {
    recordNotConnected(call.id, data.failure_reason || data.reason || 'call failed');
    return;
  }
  if (type !== 'post_call_transcription') return; // e.g. post_call_audio is ignored

  const analysis = data.analysis ?? {};
  const results = analysis.data_collection_results ?? {};
  recordCallResult(call.id, {
    summary: analysis.transcript_summary ?? null,
    transcript: (data.transcript ?? [])
      .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'user', message: t.message, t: t.time_in_call_secs }))
      .filter((t) => t.message),
    outcome: val(results, 'outcome'),
    collected: Object.fromEntries(Object.keys(results).map((k) => [k, val(results, k)])),
    duration: data.metadata?.call_duration_secs ?? null,
  });
}
