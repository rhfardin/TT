// Data access on top of a tiny SQL adapter, so the same queries run on node:sqlite and Cloudflare D1.
// adapter: { all(sql, ...args), get(sql, ...args), run(sql, ...args) -> { lastId, changes }, batch?(statements) }
// Lists of ids are passed as one JSON parameter (json_each) because D1 allows at most 100 bound parameters.
import { UPSERT_LEAD_SQL, upsertArgs, FINAL_STATUSES } from './leads.js';

const LEAD_COLUMNS = new Set(['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category',
  'city', 'timezone', 'notes', 'status', 'attempts', 'last_called_at', 'last_summary', 'meeting_time', 'is_test', 'in_campaign',
  'hot_at', 'hot_reason', 'handled_at', 'followup_due_at', 'followup_sent_at', 'campaign_id', 'emailed']);
const CALL_COLUMNS = new Set(['conversation_id', 'call_sid', 'status', 'error', 'duration_secs', 'summary',
  'transcript', 'outcome', 'ended_at', 'answered_by', 'recording_sid', 'transfer_state', 'transfer_summary',
  'campaign_id', 'variant', 'talked', 'usage', 'cost_cents']);

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
    countEvents: async (leadId, kind) => (await db.get('SELECT COUNT(*) AS n FROM events WHERE lead_id = ? AND kind = ?', leadId, kind)).n,
    dueFollowups: (nowIso, limit = 10) => db.all(`SELECT * FROM leads WHERE followup_due_at <= ? AND followup_sent_at IS NULL
                                                   AND is_test = 0 ORDER BY followup_due_at LIMIT ?`, nowIso, limit),
    statusCounts: () => db.all('SELECT status, COUNT(*) AS n FROM leads WHERE is_test = 0 GROUP BY status'),
    markInCampaign: (list) => db.run('UPDATE leads SET in_campaign = 1 WHERE id IN (SELECT value FROM json_each(?))', ids(list)),

    // Marks the lead as being called, unless something else got there first. Returns true if we got it.
    // resetTries: start the count again (a manual "Call now" past the limit).
    async claimLeadForCall(id, maxAttempts, { resetTries = false } = {}) {
      const r = await db.run(`UPDATE leads SET status = 'calling', attempts = ${resetTries ? '1' : 'attempts + 1'}, last_called_at = ?
                              WHERE id = ? AND (? OR attempts < ?) AND status NOT IN (SELECT value FROM json_each(?))`,
      new Date().toISOString(), Number(id), resetTries ? 1 : 0, Number(maxAttempts), JSON.stringify(['calling', ...FINAL_STATUSES]));
      return r.changes === 1;
    },
    // Calls going on right now (windowMs: how long a call can possibly last).
    activeCallCount: async (windowMs = 40 * 60 * 1000) =>
      (await db.get(`SELECT COUNT(*) AS n FROM leads WHERE status = 'calling' AND last_called_at > ?`,
        new Date(Date.now() - windowMs).toISOString())).n,

    // Calls whose result never arrived shouldn't stay "calling" forever. A lead whose call was being
    // handed to the owner wanted to talk to him, so it becomes "call back" rather than "no answer".
    // transferOlderThanIso: the owner's own conversation can run for hours, so transfers get longer.
    async releaseStuckCalls(olderThanIso, transferOlderThanIso = olderThanIso) {
      await db.run(`UPDATE leads SET status = CASE WHEN EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = leads.id
                      AND c.status IN ('transferring', 'finalizing')) THEN 'callback' ELSE 'no_answer' END
                    WHERE status = 'calling' AND (last_called_at IS NULL OR last_called_at < ?)
                      AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = leads.id AND c.status IN ('transferring', 'finalizing')
                                      AND c.created_at >= datetime(?))`, olderThanIso, transferOlderThanIso);
      await db.run(`UPDATE calls SET status = 'failed', error = COALESCE(error, 'no result was received for this call')
                    WHERE status IN ('initiated', 'ringing', 'in_progress', 'pressing_keys') AND created_at < datetime(?)`, olderThanIso);
      await db.run(`UPDATE calls SET status = 'failed', error = COALESCE(error, 'the transfer never finished')
                    WHERE status IN ('transferring', 'finalizing') AND created_at < datetime(?)`, transferOlderThanIso);
    },
    hasLiveInboundCall: async (leadId) => Boolean(await db.get(`SELECT 1 AS x FROM calls WHERE lead_id = ? AND direction = 'inbound'
      AND status IN ('ringing', 'in_progress', 'transferring') AND created_at > datetime(?)`, Number(leadId), new Date(Date.now() - 3600e3).toISOString())),

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
    getCallBySid: (sid) => db.get('SELECT * FROM calls WHERE call_sid = ? ORDER BY id DESC LIMIT 1', sid),
    // Moves a call from one status to another only if nobody else did first. Returns true if we did.
    async claimCallStatus(id, from, to) {
      return (await db.run('UPDATE calls SET status = ? WHERE id = ? AND status = ?', to, Number(id), from)).changes === 1;
    },
    // The one place a call's result gets recorded; false if it already was.
    async claimCallCompletion(id) {
      return (await db.run("UPDATE calls SET status = 'completed' WHERE id = ? AND status != 'completed'", Number(id))).changes === 1;
    },
    async updateCall(id, fields) {
      const s = setClause(fields, CALL_COLUMNS);
      if (s.keys.length) await db.run(`UPDATE calls SET ${s.sql} WHERE id = ?`, ...s.args, Number(id));
    },

    // ---- Call queue ----
    nextCallAt: async (leadId) => (await db.get('SELECT not_before FROM queue_items WHERE lead_id = ?', Number(leadId)))?.not_before ?? null,
    queuedLeadIds: async (list) =>
      (await db.all('SELECT lead_id FROM queue_items WHERE lead_id IN (SELECT value FROM json_each(?))', ids(list))).map((r) => r.lead_id),
    enqueueMany: (list, notBeforeIso, ignoreWindow, reason, campaignId = null) =>
      db.run(`INSERT INTO queue_items (lead_id, not_before, ignore_window, reason, campaign_id)
              SELECT value, ?, ?, ?, ? FROM json_each(?) WHERE true ON CONFLICT(lead_id) DO NOTHING`,
      notBeforeIso, ignoreWindow ? 1 : 0, reason, campaignId, ids(list)),
    // Adds or moves one lead's queue entry (used for retries).
    // A retry never inherits "ignore calling hours" from an earlier entry.
    scheduleLead: (leadId, notBeforeIso, reason, campaignId = null) =>
      db.run(`INSERT INTO queue_items (lead_id, not_before, reason, campaign_id) VALUES (?, ?, ?, ?)
              ON CONFLICT(lead_id) DO UPDATE SET not_before = excluded.not_before, reason = excluded.reason, claimed_at = NULL,
                ignore_window = 0, campaign_id = excluded.campaign_id`,
      Number(leadId), notBeforeIso, reason, campaignId),
    // A time the business asked us to call back: kept exactly (not moved into the calling window), in no
    // campaign (so pausing one doesn't hold it up), and created fresh so it outlives the call it was set on.
    async scheduleCallback(leadId, atIso) {
      await db.run('DELETE FROM queue_items WHERE lead_id = ?', Number(leadId));
      await db.run(`INSERT INTO queue_items (lead_id, not_before, ignore_window, reason, campaign_id, created_at)
                    VALUES (?, ?, 1, 'callback requested', NULL, datetime('now'))`, Number(leadId), atIso);
    },
    callbackSetSince: async (leadId, sinceSql) => Boolean(await db.get(`SELECT 1 AS x FROM queue_items WHERE lead_id = ?
      AND reason = 'callback requested' AND created_at >= ?`, Number(leadId), sinceSql)),
    dropStoppedQueueItems: (list) =>
      db.run(`DELETE FROM queue_items WHERE lead_id IN (SELECT value FROM json_each(?))
              AND campaign_id IN (SELECT id FROM campaigns WHERE status IN ('stopped', 'archived'))`, ids(list)),
    // When the last call (of ours, not a test) went out, for the gap between calls.
    lastOutboundCallAt: async () => (await db.get(`SELECT MAX(c.created_at) AS t FROM calls c JOIN leads l ON l.id = c.lead_id
                                                   WHERE c.direction = 'outbound' AND l.is_test = 0`)).t ?? null,
    // Paused or stopped campaigns hold their place in the queue without being called.
    nextDueItem: (nowIso) =>
      db.get(`SELECT q.* FROM queue_items q LEFT JOIN campaigns c ON c.id = q.campaign_id
              WHERE q.claimed_at IS NULL AND q.not_before <= ? AND (q.campaign_id IS NULL OR c.status = 'running')
              ORDER BY q.not_before, q.id LIMIT 1`, nowIso),
    async claimQueueItem(id) {
      const r = await db.run('UPDATE queue_items SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL', new Date().toISOString(), id);
      return r.changes === 1;
    },
    rescheduleQueueItem: (id, notBeforeIso) =>
      db.run('UPDATE queue_items SET not_before = ?, claimed_at = NULL WHERE id = ?', notBeforeIso, id),
    deleteQueueItem: (id) => db.run('DELETE FROM queue_items WHERE id = ?', id),
    // keepSinceSql: a call-back time set during this call (created since then) stays.
    dequeueLead: (leadId, keepSinceSql = null) => (keepSinceSql
      ? db.run(`DELETE FROM queue_items WHERE lead_id = ? AND NOT (reason = 'callback requested' AND created_at >= ?)`, Number(leadId), keepSinceSql)
      : db.run('DELETE FROM queue_items WHERE lead_id = ?', Number(leadId))),
    async queueStats() {
      const r = await db.get(`SELECT COUNT(*) AS n, MIN(CASE WHEN q.campaign_id IS NULL OR c.status = 'running' THEN q.not_before END) AS next_at
                              FROM queue_items q LEFT JOIN campaigns c ON c.id = q.campaign_id WHERE q.claimed_at IS NULL`);
      return { pending: r.n, nextAt: r.next_at ?? null };
    },
    // Stop: nobody waiting is called, and nobody gets automatic retries from this list any more.
    async clearQueue() {
      await db.run('UPDATE leads SET in_campaign = 0 WHERE id IN (SELECT lead_id FROM queue_items)');
      await db.run('DELETE FROM queue_items');
    },

    // ---- Campaigns ----
    async createCampaign(name, variantMode) {
      return (await db.run('INSERT INTO campaigns (name, variant_mode) VALUES (?, ?)', name, variantMode)).lastId;
    },
    getCampaign: (id) => db.get('SELECT * FROM campaigns WHERE id = ?', Number(id)),
    setCampaignStatus: (id, status) => db.run('UPDATE campaigns SET status = ? WHERE id = ?', status, Number(id)),
    stopAllCampaigns: () => db.run("UPDATE campaigns SET status = 'stopped' WHERE status NOT IN ('stopped', 'archived')"),
    async dequeueCampaign(id) {
      await db.run('UPDATE leads SET in_campaign = 0 WHERE campaign_id = ?', Number(id));
      await db.run('DELETE FROM queue_items WHERE campaign_id = ?', Number(id));
    },
    setLeadsCampaign: (list, campaignId) =>
      db.run('UPDATE leads SET campaign_id = ?, in_campaign = 1 WHERE id IN (SELECT value FROM json_each(?))', campaignId, ids(list)),
    // Each campaign with its progress: how many are still waiting, were reached, are interested or said yes.
    listCampaigns: () => db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id) AS total,
        (SELECT COUNT(*) FROM queue_items q WHERE q.campaign_id = c.id) AS waiting,
        (SELECT COUNT(*) FROM calls k WHERE k.campaign_id = c.id) AS calls,
        (SELECT COUNT(*) FROM calls k WHERE k.campaign_id = c.id AND k.talked = 1) AS talked,
        (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.status IN ('interested', 'won')) AS interested,
        (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.status = 'won') AS won
      FROM campaigns c WHERE c.status != 'archived' ORDER BY c.id DESC LIMIT 50`),
    releaseStaleClaims: (olderThanIso) => db.run('UPDATE queue_items SET claimed_at = NULL WHERE claimed_at < ?', olderThanIso),

    // ---- Dashboard sessions and login attempts ----
    createSession: (id, expiresIso) => db.run('INSERT INTO sessions (id, expires_at) VALUES (?, ?)', id, expiresIso),
    sessionValid: async (id) => Boolean(id && (await db.get('SELECT 1 AS ok FROM sessions WHERE id = ? AND expires_at > ?', id, new Date().toISOString()))),
    deleteSession: (id) => db.run('DELETE FROM sessions WHERE id = ?', id),
    recentLoginFailuresAll: async (sinceIso) => (await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE at > ?', sinceIso)).n,
    recentLoginFailures: async (key, sinceIso) =>
      (await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?', key, sinceIso)).n,
    addLoginFailure: (key) => db.run('INSERT INTO login_attempts (key, at) VALUES (?, ?)', key, new Date().toISOString()),
    clearLoginFailures: (key) => db.run('DELETE FROM login_attempts WHERE key = ?', key),
    async purgeAuth() {
      const now = new Date().toISOString();
      await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
      await db.run('DELETE FROM login_attempts WHERE at < ?', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    },

    // ---- Results ----
    // Calls since `sinceIso` (test calls left out), grouped by `by`: null (totals), 'campaign', 'variant',
    // 'category' or 'day'. Interested = interested, sent the preview, booked or transferred; won = said yes.
    analytics(sinceIso, by = null) {
      const group = { campaign: "COALESCE(k.name, 'No campaign')", variant: "COALESCE(c.variant, 'A')",
        category: "COALESCE(l.category, 'No category')", day: 'date(c.created_at)' }[by];
      return db.all(`
        SELECT ${group ? `${group} AS label,` : ''}
          COUNT(*) AS calls,
          SUM(CASE WHEN c.talked = 1 THEN 1 ELSE 0 END) AS talked,
          SUM(CASE WHEN c.answered_by LIKE 'machine%' OR json_extract(c.outcome, '$.outcome') = 'voicemail' THEN 1 ELSE 0 END) AS voicemail,
          SUM(CASE WHEN json_extract(c.outcome, '$.outcome') IN ('interested', 'link_sent', 'meeting_booked', 'transferred', 'sold') THEN 1 ELSE 0 END) AS interested,
          SUM(CASE WHEN json_extract(c.outcome, '$.outcome') = 'meeting_booked' THEN 1 ELSE 0 END) AS booked,
          SUM(CASE WHEN json_extract(c.outcome, '$.outcome') = 'sold' THEN 1 ELSE 0 END) AS won,
          SUM(CASE WHEN c.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
          ROUND(AVG(CASE WHEN c.talked = 1 THEN c.duration_secs END)) AS avg_talk_secs,
          ROUND(SUM(COALESCE(c.cost_cents, 0)), 2) AS cost_cents
        FROM calls c JOIN leads l ON l.id = c.lead_id LEFT JOIN campaigns k ON k.id = c.campaign_id
        WHERE l.is_test = 0 AND c.created_at >= datetime(?)
          ${by === 'variant' ? "AND c.direction = 'outbound' AND k.variant_mode IN ('A', 'B', 'AB')" : ''}
        ${group ? `GROUP BY label ORDER BY ${by === 'day' ? 'label' : 'calls DESC'} LIMIT ${by === 'day' ? 400 : 60}` : ''}`, sinceIso);
    },
    // Everything about every business, for the spreadsheet export.
    exportLeads: () => db.all(`
      SELECT l.business_name, l.contact_name, l.phone, l.email, l.website, l.demo_link, l.category, l.city, l.status,
        l.attempts, l.last_called_at, l.meeting_time, l.hot_reason, l.last_summary,
        (SELECT json_extract(c.outcome, '$.next_step') FROM calls c WHERE c.lead_id = l.id ORDER BY c.id DESC LIMIT 1) AS next_step,
        (SELECT json_extract(c.outcome, '$.requests') FROM calls c WHERE c.lead_id = l.id ORDER BY c.id DESC LIMIT 1) AS requests,
        k.name AS campaign, l.notes
      FROM leads l LEFT JOIN campaigns k ON k.id = l.campaign_id WHERE l.is_test = 0 ORDER BY l.id LIMIT 50000`),
    bulkStatus: (list, status) => db.run('UPDATE leads SET status = ? WHERE id IN (SELECT value FROM json_each(?)) AND status != ?',
      status, ids(list), 'calling'),

    // ---- Do-not-call list ----
    async addDnc(phones, source) {
      if (!phones.length) return;
      const list = JSON.stringify(phones);
      await db.run('INSERT OR IGNORE INTO dnc_numbers (phone, source) SELECT value, ? FROM json_each(?)', source, list);
      await db.run("UPDATE leads SET status = 'dnc' WHERE phone IN (SELECT value FROM json_each(?)) AND status != 'calling'", list);
    },
    isDnc: async (phone) => Boolean(await db.get('SELECT 1 AS x FROM dnc_numbers WHERE phone = ?', phone)),
    async removeDnc(phone) {
      await db.run('DELETE FROM dnc_numbers WHERE phone = ?', phone);
      await db.run("UPDATE leads SET status = 'new' WHERE phone = ? AND status = 'dnc'", phone);
    },
    countDnc: async () => (await db.get('SELECT COUNT(*) AS n FROM dnc_numbers')).n,
    recentDnc: () => db.all('SELECT * FROM dnc_numbers ORDER BY added_at DESC LIMIT 50'),
    dncLeadIds: async (list) => (await db.all(`SELECT l.id FROM leads l JOIN dnc_numbers d ON d.phone = l.phone
                                                WHERE l.id IN (SELECT value FROM json_each(?))`, ids(list))).map((r) => r.id),
    // After an import: anyone on the list stays "do not call".
    applyDnc: () => db.run("UPDATE leads SET status = 'dnc' WHERE status NOT IN ('dnc', 'calling') AND phone IN (SELECT phone FROM dnc_numbers)"),

    // ---- Daily call limit (outbound calls in the last 24 hours, test calls left out) ----
    async callsLast24h() {
      const r = await db.get(`SELECT COUNT(*) AS n, MIN(c.created_at) AS oldest FROM calls c JOIN leads l ON l.id = c.lead_id
                              WHERE c.direction = 'outbound' AND l.is_test = 0 AND c.created_at >= datetime(?)`,
      new Date(Date.now() - 864e5).toISOString());
      return { count: r.n, oldest: r.oldest };
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
