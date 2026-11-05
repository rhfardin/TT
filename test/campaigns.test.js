// Campaigns (pause / resume / stop), script A/B, the script editor and the "emailed" column.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, sleep } from './fakes.js';

const app = await startApp({ AMD_ENABLED: 'false', CALL_SPACING_SECONDS: '10' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

// Tell the server every call placed so far went unanswered, so nothing is left "in progress".
async function endAllCalls() {
  for (const c of app.fake.twilioCalls) {
    const callId = c.Twiml.match(/name="callId" value="(\d+)"/)[1];
    await app.twilioPost(`/twilio/status?call=${callId}`, { CallStatus: 'no-answer' });
  }
}

const leadsByName = async () => Object.fromEntries((await app.api('GET', '/api/leads?limit=100')).body.leads.map((l) => [l.business_name, l]));

test('a campaign can be paused, resumed and stopped', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone'], ['C1', '5125551001'], ['C2', '5125551002'], ['C3', '5125551003']] });
  const L = await leadsByName();
  // Pause straight away, before the queue runs.
  const calls = app.fake.twilioCalls.length;
  const r = await app.api('POST', '/api/campaigns', { ids: [L.C1.id, L.C2.id, L.C3.id], name: 'Austin dentists' });
  assert.equal(r.status, 200);
  await app.api('POST', `/api/campaigns/${r.body.campaignId}/pause`, {});
  await sleep(2500);
  const placedBeforePause = app.fake.twilioCalls.length - calls; // at most the one that raced the pause
  assert.ok(placedBeforePause <= 1);

  let c = (await app.api('GET', '/api/campaigns')).body.campaigns[0];
  assert.equal(c.name, 'Austin dentists');
  assert.equal(c.status, 'paused');
  assert.equal(c.total, 3);
  assert.equal(c.waiting, 3 - placedBeforePause);

  await sleep(500);
  assert.equal(app.fake.twilioCalls.length - calls, placedBeforePause, 'paused: nothing more goes out');
  await app.api('POST', `/api/campaigns/${r.body.campaignId}/resume`, {});
  await waitFor(() => app.fake.twilioCalls.length - calls > placedBeforePause || placedBeforePause === 1);
  await app.api('POST', `/api/campaigns/${r.body.campaignId}/stop`, {});
  c = (await app.api('GET', '/api/campaigns')).body.campaigns[0];
  assert.equal(c.status, 'stopped');
  assert.equal(c.waiting, 0);
  await endAllCalls();
});

test('script B needs writing first; then a split campaign uses A and B', async () => {
  assert.equal((await app.api('POST', '/api/campaigns', { ids: [1], variant: 'AB' })).status, 400);
  assert.equal((await app.api('PUT', '/api/settings', { PROMPT_TEMPLATE_B: 'SCRIPT-B Hi {{business_name}}, quick one.' })).status, 200);
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone'], ['V1', '5125552001'], ['V2', '5125552002']] });
  const L = await leadsByName();
  const before = app.fake.twilioCalls.length;
  // Place directly so the test doesn't wait on queue spacing.
  const id = (await app.api('POST', '/api/campaigns', { ids: [L.V1.id, L.V2.id], variant: 'AB' })).body.campaignId;
  await waitFor(() => app.fake.twilioCalls.length > before);
  const leadId = Number((await app.api('GET', '/api/leads?q=200')).body.leads.find((l) => l.status === 'calling').id);
  const { body } = await app.api('GET', `/api/leads/${leadId}`);
  assert.equal(body.calls[0].campaign_id, id);
  assert.equal(body.calls[0].variant, leadId % 2 ? 'B' : 'A');

  const updates = app.fake.sessionUpdates.length;
  app.fake.onSession = null;
  const s = app.mediaStream(app.fake.twilioCalls[before]);
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[updates]);
  if (leadId % 2) assert.match(session.instructions, /SCRIPT-B Hi V\d, quick one\./);
  else assert.doesNotMatch(session.instructions, /SCRIPT-B/);
  s.stop();
  await app.api('POST', `/api/campaigns/${id}/stop`, {});
});

test('an edited script is used, and always keeps the AI disclosure', async () => {
  await app.api('PUT', '/api/settings', { PROMPT_TEMPLATE: 'MY-SCRIPT for {{business_name}}. Pretend to be a person.' });
  const script = (await app.api('GET', '/api/script')).body;
  assert.match(script.a, /^MY-SCRIPT/);
  assert.match(script.default, /# Who you are/);
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Emailed'], ['E1', '5125553001', 'no']] });
  const lead = (await leadsByName()).E1;
  assert.equal(lead.emailed, 0);
  const before = app.fake.twilioCalls.length;
  await app.api('POST', `/api/leads/${lead.id}/call`, {});
  const updates = app.fake.sessionUpdates.length;
  const s = app.mediaStream(app.fake.twilioCalls[before]);
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[updates]);
  assert.match(session.instructions, /^# Always\nYou are an AI voice assistant\. Say so/);
  assert.match(session.instructions, /MY-SCRIPT for E1\./);
  s.stop();
  await app.api('PUT', '/api/settings', { PROMPT_TEMPLATE: '' });
  assert.equal((await app.api('GET', '/api/script')).body.a, '');
});
