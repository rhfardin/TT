// The do-not-call list from the dashboard, on the real Node server.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './fakes.js';

const app = await startApp();
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

test('pasting numbers into Settings, and importing a sheet that has one of them', async () => {
  const r = await app.api('POST', '/api/dnc', { numbers: '(512) 555-0700\n+1 305 555 0700, not a number' });
  assert.deepEqual([r.body.added, r.body.invalid, r.body.count], [2, 1, 2]);
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone'], ['Listed', '512-555-0700'], ['Fine', '512-555-0701']] });
  const leads = Object.fromEntries((await app.api('GET', '/api/leads')).body.leads.map((l) => [l.business_name, l.status]));
  assert.deepEqual(leads, { Listed: 'dnc', Fine: 'new' });
  assert.equal((await app.api('DELETE', '/api/dnc/+15125550700')).body.count, 1);
  assert.deepEqual((await app.api('GET', '/api/status')).body.today, { calls: 0, limit: 80, spentCents: 0, spendLimitCents: 0 });
});
