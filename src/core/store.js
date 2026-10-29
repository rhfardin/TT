// Data access on top of a tiny SQL adapter, so the same queries run on node:sqlite and Cloudflare D1.
// adapter: { all(sql, ...args), get(sql, ...args), run(sql, ...args) -> { lastId }, batch?(statements) }
import { UPSERT_LEAD_SQL, upsertArgs } from './leads.js';

const LEAD_COLUMNS = new Set(['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category',
  'city', 'timezone', 'notes', 'status', 'attempts', 'last_called_at', 'last_summary', 'meeting_time']);
const CALL_COLUMNS = new Set(['conversation_id', 'call_sid', 'status', 'error', 'duration_secs', 'summary',
  'transcript', 'outcome', 'ended_at']);

function setClause(fields, allowed) {
  const keys = Object.keys(fields).filter((k) => allowed.has(k));
  return { keys, sql: keys.map((k) => `${k} = ?`).join(', '), args: keys.map((k) => fields[k] ?? null) };
}

export function createStore(db) {
  return {
    getLead: (id) => db.get('SELECT * FROM leads WHERE id = ?', Number(id)),
    getLeadByPhone: (phone) => db.get('SELECT * FROM leads WHERE phone = ?', phone),
    async updateLead(id, fields) {
      const s = setClause(fields, LEAD_COLUMNS);
      if (s.keys.length) await db.run(`UPDATE leads SET ${s.sql} WHERE id = ?`, ...s.args, Number(id));
    },
    async deleteLead(id) {
      await db.run('DELETE FROM events WHERE lead_id = ?', Number(id));
      await db.run('DELETE FROM calls WHERE lead_id = ?', Number(id));
      await db.run('DELETE FROM leads WHERE id = ?', Number(id));
    },
    async upsertLeads(leads) {
      if (db.batch) return db.batch(leads.map((l) => [UPSERT_LEAD_SQL, ...upsertArgs(l)]));
      for (const l of leads) await db.run(UPSERT_LEAD_SQL, ...upsertArgs(l));
    },
    listLeads({ status, category, q } = {}) {
      const where = [];
      const args = [];
      if (status) {
        const list = String(status).split(',').filter(Boolean);
        where.push(`status IN (${list.map(() => '?').join(', ')})`);
        args.push(...list);
      }
      if (category) { where.push('category = ?'); args.push(category); }
      if (q) {
        where.push('(business_name LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR city LIKE ?)');
        args.push(...Array(4).fill(`%${q}%`));
      }
      return db.all(`SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 2000`, ...args);
    },
    async categories() {
      return (await db.all('SELECT DISTINCT category FROM leads WHERE category IS NOT NULL ORDER BY category')).map((r) => r.category);
    },
    statusCounts: () => db.all('SELECT status, COUNT(*) AS n FROM leads GROUP BY status'),
    // Leads whose post-call result never arrived shouldn't stay "calling" forever.
    releaseStuckCalls: (olderThanIso) =>
      db.run(`UPDATE leads SET status = 'no_answer' WHERE status = 'calling' AND last_called_at < ?`, olderThanIso),

    getCall: (id) => db.get('SELECT * FROM calls WHERE id = ?', Number(id)),
    getCallByConversation: (convId) => db.get('SELECT * FROM calls WHERE conversation_id = ?', convId),
    callsForLead: (leadId) => db.all('SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC', Number(leadId)),
    async insertCall(leadId, conversationId = null) {
      return (await db.run('INSERT INTO calls (lead_id, conversation_id) VALUES (?, ?)', Number(leadId), conversationId)).lastId;
    },
    async updateCall(id, fields) {
      const s = setClause(fields, CALL_COLUMNS);
      if (s.keys.length) await db.run(`UPDATE calls SET ${s.sql} WHERE id = ?`, ...s.args, Number(id));
    },

    async logEvent(leadId, kind, detail) {
      await db.run('INSERT INTO events (lead_id, kind, detail) VALUES (?, ?, ?)', leadId ?? null, kind,
        typeof detail === 'string' ? detail : JSON.stringify(detail ?? null));
    },
    async getSettings() {
      return Object.fromEntries((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
    },
    async saveSettings(values) {
      for (const [key, value] of Object.entries(values)) {
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      }
    },
    eventsForLead: (leadId) => db.all('SELECT * FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 50', Number(leadId)),
  };
}
