import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';

const app = await startApp({ YOUR_NAME: 'Fardin' }); // live transfer off (the default)
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

test('with live transfer off, the AI offers a callback instead and has no transfer tool', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], ['Spa', '5125550500', 'https://demo.test/x']] });
  const lead = (await app.api('GET', '/api/leads')).body.leads[0];
  await app.api('POST', `/api/leads/${lead.id}/call`, {});
  const s = app.mediaStream(app.fake.twilioCalls[0]);
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[0]);
  assert.ok(!session.tools.some((t) => t.name === 'transfer_to_fardin'));
  assert.match(session.instructions, /can't jump on right this minute/);
  s.stop();
});

test('turning live transfer on without a phone number is refused', async () => {
  const r = await app.api('PUT', '/api/settings', { TRANSFER_ENABLED: 'true' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /phone number/);
  assert.equal((await app.api('PUT', '/api/settings', { TRANSFER_ENABLED: 'true', TRANSFER_PHONE: '+15559990000' })).status, 200);
});
