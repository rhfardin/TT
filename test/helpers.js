// Shared test setup: an in-memory database and a context like the one the servers build.
import { openSqlite } from '../src/sqlite.js';
import { migrate } from '../src/core/schema.js';
import { createStore } from '../src/core/store.js';
import { buildConfig } from '../src/core/config.js';

export async function memoryStore() {
  const db = openSqlite(':memory:');
  await migrate(db);
  return { db, store: createStore(db) };
}

export async function makeCtx(env = {}) {
  const { db, store } = await memoryStore();
  const config = buildConfig({ ADMIN_PASSWORD: 'pw', CALL_WINDOW_START: '0', CALL_WINDOW_END: '24', CALL_DAYS: '1,2,3,4,5,6,7', ALLOW_LOCAL_URL: 'true', ...env });
  const sent = [];
  const ctx = { config, env, store, sendEmail: async (to, subject, text) => sent.push({ to, subject, text }) };
  return { ctx, db, store, sent };
}

export const lead = (overrides = {}) => ({
  business_name: 'Bright Smile Dental', contact_name: null, phone: '+15125550100', email: null, website: null,
  demo_link: 'https://demo.test/bright', category: 'dental', city: 'Austin', timezone: null, notes: null, extra: '{}',
  ...overrides,
});
