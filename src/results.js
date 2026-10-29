import { db, getLead, updateLead, logEvent } from './db.js';

// Maps the "outcome" the call analysis produced to a lead status.
const OUTCOME_STATUS = {
  sold: 'won',
  won: 'won',
  interested: 'interested',
  meeting_booked: 'interested',
  link_sent: 'interested',
  callback: 'callback',
  gatekeeper: 'callback',
  not_interested: 'not_interested',
  wrong_number: 'not_interested',
  do_not_call: 'dnc',
  voicemail: 'voicemail',
  no_answer: 'no_answer',
};

export const OUTCOMES = Object.keys(OUTCOME_STATUS);

// Shared by both voice providers once a call has ended.
export function recordCallResult(callId, { summary, transcript, outcome, collected = {}, duration }) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call) return;
  const lead = getLead(call.lead_id);
  outcome = String(outcome ?? '').toLowerCase().trim();

  db.prepare(`UPDATE calls SET status = 'completed', duration_secs = ?, summary = ?, transcript = ?, outcome = ?,
              ended_at = datetime('now') WHERE id = ?`)
    .run(duration ?? null, summary ?? null, JSON.stringify(transcript ?? []),
      JSON.stringify({ outcome, ...collected }), callId);

  const fields = { last_summary: summary ?? null };
  // A "do not call" set by a tool during the call wins over anything else.
  if (lead.status !== 'dnc') {
    const talked = (transcript ?? []).filter((t) => t.role === 'user').length > 0;
    fields.status = OUTCOME_STATUS[outcome] ?? (talked ? 'completed' : 'no_answer');
  }
  if (collected.meeting_time) fields.meeting_time = String(collected.meeting_time);
  if (collected.email && !lead.email) fields.email = String(collected.email);
  if (collected.decision_maker_name && !lead.contact_name) fields.contact_name = String(collected.decision_maker_name);
  updateLead(lead.id, fields);
  logEvent(lead.id, 'call_completed', { outcome, duration });
}

export function recordNotConnected(callId, reason) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || call.status === 'completed') return;
  db.prepare(`UPDATE calls SET status = 'no_answer', error = ?, ended_at = datetime('now') WHERE id = ?`)
    .run(String(reason), callId);
  const lead = getLead(call.lead_id);
  if (lead?.status === 'calling') updateLead(lead.id, { status: 'no_answer' });
  logEvent(call.lead_id, 'call_not_connected', reason);
}
