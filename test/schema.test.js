import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/sqlite.js';
import { migrate, SCHEMA, SCHEMA_VERSION } from '../src/core/schema.js';

test('migrate builds a new database at the current version', async () => {
  const db = openSqlite(':memory:');
  assert.equal(await migrate(db), SCHEMA_VERSION);
  assert.equal(await migrate(db), SCHEMA_VERSION, 'running again is a no-op');
});

test('migrate upgrades a database created by the first release', async () => {
  const db = openSqlite(':memory:');
  for (const stmt of SCHEMA) await db.run(stmt); // old releases had no meta table
  await db.run("INSERT INTO leads (business_name, phone) VALUES ('Old Lead', '+15125550100')");
  assert.equal(await migrate(db), SCHEMA_VERSION);
  assert.equal((await db.get('SELECT business_name FROM leads')).business_name, 'Old Lead');
});
