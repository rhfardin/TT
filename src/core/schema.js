// Database schema. SCHEMA creates the original tables; MIGRATIONS bring any database (new or old)
// up to the current version. Both node:sqlite and Cloudflare D1 run them through migrate().

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
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
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
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
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    kind TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

// Each entry runs once, in order. Never edit a released migration; add a new one.
export const MIGRATIONS = [
  {
    version: 2,
    statements: [
      'CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)',
      'CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id)',
      'CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)',
    ],
  },
  {
    // Call queue in the database (survives restarts), dashboard sessions, test-call leads.
    version: 3,
    statements: [
      'ALTER TABLE leads ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE leads ADD COLUMN in_campaign INTEGER NOT NULL DEFAULT 0',
      `CREATE TABLE IF NOT EXISTS queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL UNIQUE,
        not_before TEXT NOT NULL,
        ignore_window INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_queue_due ON queue_items(not_before)',
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS login_attempts (key TEXT NOT NULL, at TEXT NOT NULL)',
      // The old in-memory queue marked leads "queued"; that status no longer exists.
      "UPDATE leads SET status = CASE WHEN attempts > 0 THEN 'no_answer' ELSE 'new' END WHERE status = 'queued'",
    ],
  },
  {
    // Voicemail detection result and call recordings.
    version: 4,
    statements: [
      'ALTER TABLE calls ADD COLUMN answered_by TEXT',
      'ALTER TABLE calls ADD COLUMN recording_sid TEXT',
    ],
  },
  {
    // Live transfer to the owner: ringing / connected / declined / missed, and what the AI told him.
    version: 5,
    statements: [
      'ALTER TABLE calls ADD COLUMN transfer_state TEXT',
      'ALTER TABLE calls ADD COLUMN transfer_summary TEXT',
    ],
  },
  {
    // Calls businesses make to our number (callbacks), answered by the AI.
    version: 6,
    statements: ["ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'"],
  },
  {
    // Hot leads waiting for the owner, and the optional follow-up email.
    version: 7,
    statements: [
      'ALTER TABLE leads ADD COLUMN hot_at TEXT',
      'ALTER TABLE leads ADD COLUMN hot_reason TEXT',
      'ALTER TABLE leads ADD COLUMN handled_at TEXT',
      'ALTER TABLE leads ADD COLUMN followup_due_at TEXT',
      'ALTER TABLE leads ADD COLUMN followup_sent_at TEXT',
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1).version;

// db: { get(sql, ...args), run(sql, ...args) }
export async function migrate(db) {
  for (const stmt of SCHEMA) await db.run(stmt);
  await db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const row = await db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  let version = Number(row?.value ?? 1);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    for (const stmt of m.statements) await db.run(stmt);
    await db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(m.version));
    version = m.version;
  }
  return version;
}
