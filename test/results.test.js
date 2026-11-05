// Cost estimates, the Results page, spreadsheet export, bulk edits and live transcripts.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, sleep } from './fakes.js';
import { addUsage, estimateCostCents } from '../src/core/costs.js';

test('cost: OpenAI tokens at the model\'s rates plus Twilio minutes', () => {
  const usage = addUsage(addUsage({}, {
    input_token_details: { audio_tokens: 1000, text_tokens: 2000, cached_tokens_details: { audio_tokens: 400, text_tokens: 1500 } },
    output_token_details: { audio_tokens: 1200, text_tokens: 100 },
  }), { input_token_details: { audio_tokens: 500 }, output_token_details: { audio_tokens: 300 } });
  assert.deepEqual(usage, { audioIn: 1100, audioCached: 400, textIn: 500, textCached: 1500, audioOut: 1500, textOut: 100 });
  // mini: 1100*10 + 400*0.3 + 500*0.6 + 1500*0.06 + 1500*20 + 100*2.4 = 41750 per 1M = $0.04175
  // Twilio: 125 s = 3 min * (0.014 + 0.004) = $0.054; AMD $0.0075 → $0.10325
  assert.equal(estimateCostCents({ model: 'gpt-realtime-mini', usage, seconds: 125, amd: true }), 10.33);
  assert.equal(estimateCostCents({ model: 'gpt-realtime-mini', usage: {}, seconds: 0, answered: false, amd: true }), 0.75);
});

const app = await startApp({ AMD_ENABLED: 'false' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

test('a call\'s transcript shows up while it\'s going on, and its cost and result are counted', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Category'], ['=HYPERLINK("x")', '5125554001', 'Dental']] });
  const lead = (await app.api('GET', '/api/leads')).body.leads[0];
  await app.api('POST', `/api/leads/${lead.id}/call`, {});
  app.fake.analysis = { outcome: 'interested', summary: 'Wants the site.' };
  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello, who is this?' }));
    ws.send(JSON.stringify({ type: 'response.done', response: { output: [], usage: { input_token_details: { audio_tokens: 5000 }, output_token_details: { audio_tokens: 3000 } } } }));
  };
  const s = app.mediaStream(app.fake.twilioCalls[0]);
  await s.ready;
  const liveCall = await waitFor(async () => {
    const c = (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0];
    return c.status === 'in_progress' && c.transcript.length && c;
  });
  assert.equal(liveCall.transcript[0].message, 'Hello, who is this?', 'saved during the call');
  await sleep(1100); // let a second of call time pass
  s.stop();
  const call = await waitFor(async () => {
    const c = (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0];
    return c.status === 'completed' && c;
  });
  assert.equal(call.talked, 1);
  // mini: 5000*10 + 3000*20 = 110000 per 1M = $0.11; Twilio: 1 min * 0.018 = $0.018 → 12.8 cents
  assert.equal(call.cost_cents, 12.8);

  const r = (await app.api('GET', '/api/analytics?days=7')).body;
  assert.equal(r.totals.calls, 1);
  assert.equal(r.totals.talked, 1);
  assert.equal(r.totals.interested, 1);
  assert.equal(r.totals.cost_cents, 12.8);
  assert.deepEqual(r.categories.map((c) => c.label), ['Dental']);
  assert.deepEqual(r.variants.map((v) => v.label), ['A']);
  assert.equal(r.byDay.length, 1);
});

test('export: every business as a spreadsheet, with formulas made harmless', async () => {
  const res = await app.realFetch(`${app.base}/api/export?format=csv`, { headers: { cookie: await cookie() } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store, private', 'never cached by a CDN');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="businesses-\d{4}-\d{2}-\d{2}\.csv"/);
  const text = await res.text();
  const [header, row] = text.replace(/^﻿/, '').split('\r\n');
  assert.match(header, /^business_name,contact_name,phone,/);
  assert.match(row, /^"'=HYPERLINK\(""x""\)",/);
  assert.match(row, /interested/);
});

test('several businesses can be set to a status at once', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone'], ['B1', '5125554101'], ['B2', '5125554102']] });
  const ids = (await app.api('GET', '/api/leads?q=41')).body.leads.map((l) => l.id);
  assert.equal((await app.api('POST', '/api/leads/bulk', { ids, status: 'calling' })).status, 400);
  assert.equal((await app.api('POST', '/api/leads/bulk', { ids, status: 'not_interested' })).status, 200);
  assert.deepEqual((await app.api('GET', '/api/leads?q=41')).body.leads.map((l) => l.status), ['not_interested', 'not_interested']);
});

async function cookie() {
  const r = await app.realFetch(`${app.base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ password: 'pw' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}
