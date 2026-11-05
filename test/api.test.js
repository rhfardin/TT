// Security and validation on the real Node server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './fakes.js';

const app = await startApp({ TWILIO_AUTH_TOKEN: '' }); // fresh install: no Twilio token yet
after(() => app.stop());

const raw = (method, p, { headers = {}, body } = {}) =>
  app.realFetch(app.base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });

test('unsigned Twilio callbacks are rejected and do not crash the server', async () => {
  const r = await raw('POST', '/twilio/status?call=1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'x' }, body: 'CallStatus=completed' });
  assert.equal(r.status, 403);
  assert.equal((await raw('GET', '/healthz')).status, 200);
});

test('ElevenLabs webhook is closed unless ElevenLabs is set up with a secret', async () => {
  const r = await raw('POST', '/webhooks/elevenlabs', { body: JSON.stringify({ type: 'post_call_transcription', data: { conversation_initiation_client_data: { dynamic_variables: { lead_id: '1' } } } }) });
  assert.equal(r.status, 401);
});

test('changes without the dashboard header are refused', async () => {
  const r = await raw('POST', '/api/login', { body: JSON.stringify({ password: 'pw' }) });
  assert.equal(r.status, 403);
});

test('sessions: login, use, logout revokes the cookie', async () => {
  assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200);
  assert.equal((await app.api('GET', '/api/status')).status, 200);
  const cookieBefore = (await app.api('GET', '/api/status')).status;
  assert.equal(cookieBefore, 200);
  await app.api('POST', '/api/logout');
  assert.equal((await app.api('GET', '/api/status')).status, 401);
});

test('login is locked after 5 wrong passwords', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await app.api('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 429);
});

test('a flood of wrong guesses from many addresses can\'t lock the owner out', async () => {
  const { handleRequest } = await import('../src/core/api.js');
  const { makeCtx } = await import('./helpers.js');
  const { ctx } = await makeCtx({ ADMIN_PASSWORD: 'right-password' });
  const login = (ip, password) => handleRequest(ctx, { method: 'POST', path: '/api/login', query: {}, body: { password }, headers: { 'x-requested-with': 'fetch' }, ip });
  for (let i = 0; i < 60; i++) assert.equal((await login(`10.0.${i}.1`, 'guess')).status, 401);
  assert.equal((await login('10.0.0.1', 'guess')).status, 429, 'a second guess from an address is stopped by the overall limit');
  assert.equal((await login('203.0.113.9', 'right-password')).status, 200, 'the owner still gets in');
});
