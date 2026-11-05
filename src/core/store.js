// Data access on top of a tiny SQL adapter, so the same queries run on node:sqlite and Cloudflare D1.
// adapter: { all(sql, ...args), get(sql, ...args), run(sql, ...args) -> { lastId, changes }, batch?(statements) }
// Lists of ids are passed as one JSON parameter (json_each) because D1 allows at most 100 bound parameters.
import { UPSERT_LEAD_SQL, upsertArgs, FINAL_STATUSES } from './leads.js';

const LEAD_COLUMNS = new Set(['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category',
  'city', 'timezone', 'notes', 'status', 'attempts', 'last_called_at', 'last_summary', 'meeting_time', 'is_test', 'in_campaign',
  'hot_at', 'hot_reason', 'handled_at', 'followup_due_at', 'followup_sent_at']);
const CALL_COLUMNS = new Set(['conversation_id', 'call_sid', 'status', 'error', 'duration_secs', 'summary',
  'transcript', 'outcome', 'ended_at', 'answered_by', 'recording_sid', 'transfer_state', 'transfer_summary']);

function setClause(fields, allowed) {
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  return { keys, sql: keys.map((k) => `${k} = ?`).join(', '), args: keys.map((k) => fields[k] ?? null) };
}

const ids = (list) => JSON.stringify(list.map(Number).filter(Number.isFinite));

function leadFilter({ status, q } = {}) {
  const where = ['leads.is_test = 0'];
  const args = [];
  if (status) {
    where.push('leads.status IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(String(status).split(',').filter(Boolean)));
  }
  if (q) {
    where.push('(business_name LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR city LIKE ?)');
    args.push(...Array(4).fill(`%${q}%`));
  }
  return { sql: where.join(' AND '), args };
}

export function createStore(db) {
  return {
    // ---- Leads ----
    getLead: (id) => db.get('SELECT * FROM leads WHERE id = ?', Number(id)),
    getLeadByPhone: (phone) => db.get('SELECT * FROM leads WHERE phone = ?', phone),
    getLeadsByIds: (list) => db.all('SELECT * FROM leads WHERE id IN (SELECT value FROM json_each(?))', ids(list)),
    async updateLead(id, fields) {
      const s = setClause(fields, LEAD_COLUMNS);
      if (s.keys.length) await db.run(`UPDATE leads SET ${s.sql} WHERE id = ?`, ...s.args, Number(id));
    },
    async deleteLead(id) {
      await db.run('DELETE FROM queue_items WHERE lead_id = ?', Number(id));
      await db.run('DELETE FROM events WHERE lead_id = ?', Number(id));
      await db.run('DELETE FROM calls WHERE lead_id = ?', Number(id));
      await db.run('DELETE FROM leads WHERE id = ?', Number(id));
    },
    async upsertLeads(leads) {
      if (db.batch) return db.batch(leads.map((l) => [UPSERT_LEAD_SQL, ...upsertArgs(l)]));
      for (const l of leads) await db.run(UPSERT_LEAD_SQL, ...upsertArgs(l));
    },
    listLeads(filter = {}) {
      const f = leadFilter(filter);
      const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 500);
      const offset = Math.max(Number(filter.offset) || 0, 0);
      return db.all(`SELECT leads.*, q.not_before AS next_call_at FROM leads
                     LEFT JOIN queue_items q ON q.lead_id = leads.id
                     WHERE ${f.sql} ORDER BY leads.id DESC LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    },
    async countLeads(filter = {}) {
      const f = leadFilter(filter);
      return (await db.get(`SELECT COUNT(*) AS n FROM leads WHERE ${f.sql}`, ...f.args)).n;
    },
    // Hot leads the owner hasn't dealt with yet, newest first.
    needsYou: () => db.all(`SELECT * FROM leads WHERE is_test = 0 AND hot_at IS NOT NULL
                            AND (handled_at IS NULL OR handled_at < hot_at) ORDER BY hot_at DESC LIMIT 100`),
    countNeedsYou: async () => (await db.get(`SELECT COUNT(*) AS n FROM leads WHERE is_test = 0 AND hot_at IS NOT NULL
                                              AND (handled_at IS NULL OR handled_at < hot_at)`)).n,
    dueFollowups: (nowIso, limit = 10) => db.all(`SELECT * FROM leads WHERE followup_due_at <= ? AND followup_sent_at IS NULL
                                                   AND is_test = 0 ORDER BY followup_due_at LIMIT ?`, nowIso, limit),
    statusCounts: () => db.all('SELECT status, COUNT(*) AS n FROM leads WHERE is_test = 0 GROUP BY status'),
    markInCampaign: (list) => db.run('UPDATE leads SET in_campaign = 1 WHERE id IN (SELECT value FROM json_each(?))', ids(list)),

    // Marks the lead as being called, unless something else got there first. Returns true if we got it.
    async claimLeadForCall(id, maxAttempts) {
      const r = await db.run(`UPDATE leads SET status = 'calling', attempts = attempts + 1, last_called_at = ?
                              WHERE id = ? AND attempts < ? AND status NOT IN (SELECT value FROM json_each(?))`,
      new Date().toISOString(), Number(id), Number(maxAttempts), JSON.stringify(['calling', ...FINAL_STATUSES]));
      return r.changes === 1;
    },
    activeCallCount: async () =>
      (await db.get(`SELECT COUNT(*) AS n FROM leads WHERE status = 'calling' AND last_called_at > ?`,
        new Date(Date.now() - 15 * 60 * 1000).toISOString())).n,

    // Calls whose result never arrived shouldn't stay "calling" forever.
    async releaseStuckCalls(olderThanIso) {
      await db.run(`UPDATE leads SET status = 'no_answer' WHERE status = 'calling' AND (last_called_at IS NULL OR last_called_at < ?)`,
        olderThanIso);
      await db.run(`UPDATE calls SET status = 'failed', error = COALESCE(error, 'no result was received for this call')
                    WHERE status IN ('initiated', 'ringing', 'in_progress') AND created_at < datetime(?)`, olderThanIso);
    },

    // ---- Calls ----
    getCall: (id) => db.get('SELECT * FROM calls WHERE id = ?', Number(id)),
    getCallByConversation: (convId) => db.get('SELECT * FROM calls WHERE conversation_id = ?', convId),
    callsForLead: (leadId) => db.all('SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC', Number(leadId)),
    async insertCall(leadId, conversationId = null) {
      return (await db.run('INSERT INTO calls (lead_id, conversation_id) VALUES (?, ?)', Number(leadId), conversationId)).lastId;
    },
    async insertInboundCall(leadId, callSid) {
      return (await db.run(`INSERT INTO calls (lead_id, call_sid, direction, status) VALUES (?, ?, 'inbound', 'ringing')`,
        Number(leadId), callSid)).lastId;
    },
    // Moves a call from one status to another only if nobody else did first. Returns true if we did.
    async claimCallStatus(id, from, to) {
      return (await db.run('UPDATE calls SET status = ? WHERE id = ? AND status = ?', to, Number(id), from)).changes === 1;
    },
    async updateCall(id, fields) {
      const s = setClause(fields, CALL_COLUMNS);
      if (s.keys.length) await db.run(`UPDATE calls SET ${s.sql} WHERE id = ?`, ...s.args, Number(id));
    },

    // ---- Call queue ----
    nextCallAt: async (leadId) => (await db.get('SELECT not_before FROM queue_items WHERE lead_id = ?', Number(leadId)))?.not_before ?? null,
    queuedLeadIds: async (list) =>
      (await db.all('SELECT lead_id FROM queue_items WHERE lead_id IN (SELECT value FROM json_each(?))', ids(list))).map((r) => r.lead_id),
    enqueueMany: (list, notBeforeIso, ignoreWindow, reason) =>
      db.run(`INSERT INTO queue_items (lead_id, not_before, ignore_window, reason)
              SELECT value, ?, ?, ? FROM json_each(?) WHERE true ON CONFLICT(lead_id) DO NOTHING`,
      notBeforeIso, ignoreWindow ? 1 : 0, reason, ids(list)),
    // Adds or moves one lead's queue entry (used for retries).
    scheduleLead: (leadId, notBeforeIso, reason) =>
      db.run(`INSERT INTO queue_items (lead_id, not_before, reason) VALUES (?, ?, ?)
              ON CONFLICT(lead_id) DO UPDATE SET not_before = excluded.not_before, reason = excluded.reason, claimed_at = NULL`,
      Number(leadId), notBeforeIso, reason),
    nextDueItem: (nowIso) =>
      db.get('SELECT * FROM queue_items WHERE claimed_at IS NULL AND not_before <= ? ORDER BY not_before, id LIMIT 1', nowIso),
    async claimQueueItem(id) {
      const r = await db.run('UPDATE queue_items SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL', new Date().toISOString(), id);
      return r.changes === 1;
    },
    rescheduleQueueItem: (id, notBeforeIso) =>
      db.run('UPDATE queue_items SET not_before = ?, claimed_at = NULL WHERE id = ?', notBeforeIso, id),
    deleteQueueItem: (id) => db.run('DELETE FROM queue_items WHERE id = ?', id),
    dequeueLead: (leadId) => db.run('DELETE FROM queue_items WHERE lead_id = ?', Number(leadId)),
    async queueStats() {
      const r = await db.get('SELECT COUNT(*) AS n, MIN(not_before) AS next_at FROM queue_items WHERE claimed_at IS NULL');
      return { pending: r.n, nextAt: r.next_at ?? null };
    },
    clearQueue: () => db.run('DELETE FROM queue_items'),
    releaseStaleClaims: (olderThanIso) => db.run('UPDATE queue_items SET claimed_at = NULL WHERE claimed_at < ?', olderThanIso),

    // ---- Dashboard sessions and login attempts ----
    createSession: (id, expiresIso) => db.run('INSERT INTO sessions (id, expires_at) VALUES (?, ?)', id, expiresIso),
    sessionValid: async (id) => Boolean(id && (await db.get('SELECT 1 AS ok FROM sessions WHERE id = ? AND expires_at > ?', id, new Date().toISOString()))),
    deleteSession: (id) => db.run('DELETE FROM sessions WHERE id = ?', id),
    recentLoginFailures: async (key, sinceIso) =>
      (await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?', key, sinceIso)).n,
    addLoginFailure: (key) => db.run('INSERT INTO login_attempts (key, at) VALUES (?, ?)', key, new Date().toISOString()),
    clearLoginFailures: (key) => db.run('DELETE FROM login_attempts WHERE key = ?', key),
    async purgeAuth() {
      const now = new Date().toISOString();
      await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
      await db.run('DELETE FROM login_attempts WHERE at < ?', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    },

    // ---- Events and settings ----
    async logEvent(leadId, kind, detail) {
      await db.run('INSERT INTO events (lead_id, kind, detail) VALUES (?, ?, ?)', leadId ?? null, kind,
        typeof detail === 'string' ? detail : JSON.stringify(detail ?? null));
    },
    eventsForLead: (leadId) => db.all('SELECT * FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 50', Number(leadId)),
    async getSettings() {
      return Object.fromEntries((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
    },
    async saveSettings(values) {
      for (const [key, value] of Object.entries(values)) {
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      }
    },
  };
}
