import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './fakes.js';

const app = await startApp({ DEFAULT_TIMEZONE: 'America/Toronto' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

test('settings hide secrets and keep values from the environment', async () => {
  const { body } = await app.api('GET', '/api/settings');
  assert.deepEqual(body.OPENAI_API_KEY, { set: true, hint: '…test' });
  assert.equal(body.DEFAULT_TIMEZONE, 'America/Toronto');
});

test('bad settings are refused with a clear reason', async () => {
  let r = await app.api('PUT', '/api/settings', { CALL_WINDOW_START: '10', CALL_WINDOW_END: '9' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /before end hour/);
  r = await app.api('PUT', '/api/settings', { MAX_ATTEMPTS: 'lots' });
  assert.match(r.body.error, /Max tries/);
  r = await app.api('PUT', '/api/settings', { DEFAULT_TIMEZONE: 'Mars/Base' });
  assert.match(r.body.error, /timezone/);
  assert.equal((await app.api('PUT', '/api/settings', { YOUR_NAME: 'Fardin' })).status, 200);
});

test('leads: paging, safe edits, test calls never touch real businesses', async () => {
  const rows = [['Business', 'Phone'], ...Array.from({ length: 30 }, (_, i) => [`Biz ${i}`, `512555${String(1000 + i)}`])];
  assert.equal((await app.api('POST', '/api/import', { rows })).body.imported, 30);
  const page = await app.api('GET', '/api/leads?limit=10');
  assert.equal(page.body.leads.length, 10);
  assert.equal(page.body.total, 30);

  const id = page.body.leads[0].id;
  assert.equal((await app.api('PATCH', `/api/leads/${id}`, { status: 'calling' })).status, 400);
  assert.equal((await app.api('PATCH', `/api/leads/${id}`, { attempts: '<img>' })).status, 400);
  assert.equal((await app.api('PATCH', `/api/leads/${id}`, { status: 'callback' })).body.status, 'callback');

  const taken = await app.api('POST', '/api/test-call', { phone: page.body.leads[0].phone });
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /belongs to/);
  const t = await app.api('POST', '/api/test-call', { phone: '+15125559999', business_name: 'Pretend Dental' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal((await app.api('GET', '/api/leads?limit=100')).body.total, 30, 'test lead is hidden from the list');
});
