// The do-not-call list and the daily call limit.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, lead } from './helpers.js';
import { placeCall, markDoNotCall } from '../src/core/actions.js';
import { enqueueLeads, runDue } from '../src/core/queue.js';

const TWILIO = { OPENAI_API_KEY: 'sk', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000' };
const realFetch = globalThis.fetch;
let placed;
beforeEach(() => {
  placed = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ sid: `CA${++placed}` }), { status: 201 });
});
afterEach(() => { globalThis.fetch = realFetch; });

test('numbers on the do-not-call list are never called or queued', async () => {
  const { ctx, store } = await makeCtx(TWILIO);
  await store.upsertLeads([lead(), lead({ phone: '+15125550101' })]);
  await store.addDnc(['+15125550100'], 'test');
  assert.equal((await store.getLead(1)).status, 'dnc', 'existing lead marked straight away');
  await store.updateLead(1, { status: 'new' }); // even if someone changes it back by hand...
  const r = await placeCall(ctx, 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /do-not-call list/);
  assert.equal(placed, 0);
  await store.updateLead(1, { status: 'new' });
  const q = await enqueueLeads(ctx, [1, 2]);
  assert.deepEqual(q.map((x) => x.queued), [false, true]);
});

test('"don\'t call me again" on a call adds the number to the list', async () => {
  const { ctx, store } = await makeCtx(TWILIO);
  await store.upsertLeads([lead()]);
  await markDoNotCall(ctx, { lead_id: 1, reason: 'asked' });
  assert.equal(await store.isDnc('+15125550100'), true);
});

test('the daily limit stops calls and the queue waits until a slot frees up', async () => {
  const { ctx, store } = await makeCtx({ ...TWILIO, MAX_CALLS_PER_DAY: '2' });
  await store.upsertLeads([lead(), lead({ phone: '+15125550101' }), lead({ phone: '+15125550102' })]);
  for (const id of [1, 2]) {
    assert.equal((await placeCall(ctx, id)).ok, true);
    await store.updateLead(id, { status: 'no_answer' });
  }
  const third = await placeCall(ctx, 3);
  assert.equal(third.ok, false);
  assert.match(third.error, /daily limit reached \(2 calls in 24 hours\)/);
  await enqueueLeads(ctx, [3]);
  const r = await runDue(ctx);
  assert.equal(r.placed, false);
  assert.ok(r.waitMs > 23 * 3600 * 1000, `waits ~24h, got ${r.waitMs}`);
  assert.equal(placed, 2);
});

test('test calls don\'t count against, and aren\'t blocked by, the daily limit', async () => {
  const { ctx, store } = await makeCtx({ ...TWILIO, MAX_CALLS_PER_DAY: '1' });
  await store.upsertLeads([lead(), lead({ phone: '+15125550109' })]);
  await store.updateLead(2, { is_test: 1 });
  assert.equal((await placeCall(ctx, 1)).ok, true);
  assert.equal((await placeCall(ctx, 2)).ok, true);
});

