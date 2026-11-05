import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, lead } from './helpers.js';
import { enqueueLeads, runDue, clearQueue } from '../src/core/queue.js';
import { placeCall } from '../src/core/actions.js';

const TWILIO = { OPENAI_API_KEY: 'sk', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000' };
const HOURS = { CALL_WINDOW_START: '9', CALL_WINDOW_END: '17', CALL_DAYS: '1,2,3,4,5' };
let calls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(Object.fromEntries(new URLSearchParams(opts.body)));
    return new Response(JSON.stringify({ sid: `CA${calls.length}` }), { status: 201 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function setup(env = {}, leads = [lead()]) {
  const t = await makeCtx({ ...TWILIO, ...env });
  await t.store.upsertLeads(leads);
  return t;
}

test('a lead outside its calling hours waits for its window instead of being dropped', async () => {
  const { ctx, store, db } = await setup(HOURS, [lead({ phone: '+13105550100', business_name: 'LA Spa' })]);
  const nineAmNewYork = new Date('2026-11-04T14:00:00Z'); // 6am in Los Angeles
  await enqueueLeads(ctx, [1], { now: nineAmNewYork });
  const r = await runDue(ctx, nineAmNewYork);
  assert.equal(r.placed, false);
  assert.equal(calls.length, 0);
  const item = await db.get('SELECT * FROM queue_items WHERE lead_id = 1');
  assert.equal(item.not_before, '2026-11-04T17:00:00.000Z'); // 9am in Los Angeles
  assert.equal(r.waitMs, 3 * 3600 * 1000);
  assert.equal((await store.getLead(1)).status, 'new', 'status is not touched by queueing');
});

test('due leads are called one at a time', async () => {
  const { ctx, store } = await setup({}, [lead(), lead({ phone: '+15125550101', business_name: 'Second' })]);
  await enqueueLeads(ctx, [1, 2]);
  assert.equal((await runDue(ctx)).placed, true);
  assert.equal(calls.length, 1);
  assert.equal((await store.getLead(1)).status, 'calling');
  const r = await runDue(ctx);
  assert.equal(r.placed, false, 'waits while a call is in progress');
  assert.equal(calls.length, 1);
  await store.updateLead(1, { status: 'no_answer' });
  assert.equal((await runDue(ctx)).placed, true);
  assert.equal(calls.length, 2);
});

test('the queue is kept while calling keys are missing', async () => {
  const { ctx, db } = await setup({ OPENAI_API_KEY: '' });
  await enqueueLeads(ctx, [1]);
  assert.equal((await runDue(ctx)).placed, false);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM queue_items')).n, 1);
});

test('enqueue skips do-not-call leads and leads already waiting', async () => {
  const { ctx, store } = await setup({}, [lead(), lead({ phone: '+15125550101' })]);
  await store.updateLead(2, { status: 'dnc' });
  await enqueueLeads(ctx, [1]);
  const r = await enqueueLeads(ctx, [1, 2]);
  assert.deepEqual(r.map((x) => x.queued), [false, false]);
  assert.match(r[0].reason, /already waiting/);
  assert.match(r[1].reason, /dnc/);
});

test('stopping the queue keeps each lead\'s real status', async () => {
  const { ctx, store } = await setup();
  await store.updateLead(1, { status: 'interested' });
  await enqueueLeads(ctx, [1]);
  await clearQueue(ctx);
  assert.equal((await store.getLead(1)).status, 'interested');
});

test('two calls for the same lead at once: only one goes through', async () => {
  const { ctx } = await setup();
  const [a, b] = await Promise.all([placeCall(ctx, 1), placeCall(ctx, 1)]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal(calls.length, 1);
});

test('no answer from a business in the call list schedules a retry inside its calling hours', async () => {
  const { ctx, db, store } = await setup({ ...HOURS, RETRY_NO_ANSWER_HOURS: '24' });
  await enqueueLeads(ctx, [1]);
  const callId = await store.insertCall(1);
  await store.updateLead(1, { status: 'calling', attempts: 1 });
  const { recordNotConnected } = await import('../src/core/actions.js');
  await recordNotConnected(ctx, callId, 'no-answer');
  const item = await db.get('SELECT * FROM queue_items WHERE lead_id = 1');
  assert.ok(item, 'retry queued');
  const at = new Date(item.not_before);
  assert.ok(at - Date.now() > 20 * 3600 * 1000, 'about a day later');
  const { canCallNow } = await import('../src/core/leads.js');
  assert.equal(canCallNow(await store.getLead(1), ctx.config.calling, at).ok, true, 'inside calling hours');
});

test('manual one-off calls and test calls are not retried', async () => {
  const { ctx, db, store } = await setup();
  const callId = await store.insertCall(1);
  await store.updateLead(1, { status: 'calling', attempts: 1 });
  const { recordNotConnected } = await import('../src/core/actions.js');
  await recordNotConnected(ctx, callId, 'busy');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM queue_items')).n, 0);
});
