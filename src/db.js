import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'caller.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    website TEXT,
    demo_link TEXT,
    category TEXT,
    city TEXT,
    timezone TEXT,
    notes TEXT,
    extra TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_called_at TEXT,
    last_summary TEXT,
    meeting_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    conversation_id TEXT UNIQUE,
    call_sid TEXT,
    status TEXT NOT NULL DEFAULT 'initiated',
    error TEXT,
    duration_secs INTEGER,
    summary TEXT,
    transcript TEXT,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function logEvent(leadId, kind, detail) {
  db.prepare('INSERT INTO events (lead_id, kind, detail) VALUES (?, ?, ?)')
    .run(leadId ?? null, kind, typeof detail === 'string' ? detail : JSON.stringify(detail ?? null));
}

export function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
}

export function updateLead(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE leads SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), Number(id));
}
