import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, lead } from './helpers.js';
import { enqueueLeads, runDue, clearQueue } from '../src/core/queue.js';
import { placeCall } from '../src/core/actions.js';

const TWILIO = { OPENAI_API_KEY: 'sk', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000', CALL_SPACING_SECONDS: '0' };
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

test('calls are spaced out by CALL_SPACING_SECONDS, even when poked', async () => {
  const { ctx, store } = await setup({ CALL_SPACING_SECONDS: '90' }, [lead(), lead({ phone: '+15125550101', business_name: 'Second' })]);
  await enqueueLeads(ctx, [1, 2]);
  assert.equal((await runDue(ctx)).placed, true);
  await store.updateLead(1, { status: 'no_answer' });
  const r = await runDue(ctx);
  assert.equal(r.placed, false, 'too soon after the last call');
  assert.ok(r.waitMs > 80 * 1000 && r.waitMs <= 90 * 1000, `waits out the gap (got ${r.waitMs})`);
  assert.equal(calls.length, 1);
  assert.equal((await runDue(ctx, new Date(Date.now() + 91 * 1000))).placed, true, 'goes out once the gap has passed');
});

test('a retry is not queued for a lead whose campaign was stopped', async () => {
  const { ctx, db, store } = await setup();
  const campaignId = await store.createCampaign('Test', 'A');
  await enqueueLeads(ctx, [1], { campaignId });
  const callId = await store.insertCall(1);
  await store.updateLead(1, { status: 'calling', attempts: 1 });
  await store.setCampaignStatus(campaignId, 'stopped');
  await db.run('DELETE FROM queue_items');
  const { recordNotConnected } = await import('../src/core/actions.js');
  await recordNotConnected(ctx, callId, 'no-answer');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM queue_items')).n, 0);
});

test('the daily limit keeps waiting leads in the queue', async () => {
  const { ctx, db } = await setup({ MAX_CALLS_PER_DAY: '1' }, [lead(), lead({ phone: '+15125550101', business_name: 'Second' })]);
  await enqueueLeads(ctx, [1, 2]);
  // Another call was placed meanwhile (e.g. "Call now" from the dashboard): the limit is now used up.
  await placeCall(ctx, 2, { ignoreWindow: true });
  await db.run("UPDATE leads SET status = 'no_answer' WHERE id = 2");
  await db.run("UPDATE calls SET status = 'completed'");
  const r = await runDue(ctx);
  assert.equal(r.placed, false);
  assert.ok(r.waitMs > 23 * 3600 * 1000, 'waits for the limit to free up');
  assert.equal(calls.length, 1);
  assert.ok(await db.get('SELECT * FROM queue_items WHERE lead_id = 1'), 'still queued');
});

test('paused: the queue waits and manual calls are refused; the spend limit works the same way', async () => {
  const { ctx } = await setup({ CALLING_PAUSED: 'true' }, [lead(), lead({ phone: '+15125550101', business_name: 'Second' })]);
  await enqueueLeads(ctx, [1]);
  let r = await runDue(ctx);
  assert.equal(r.placed, false);
  assert.ok(r.waitMs >= 60 * 1000);
  assert.match((await placeCall(ctx, 2)).error, /paused/);
  assert.equal(calls.length, 0);

  const spend = await setup({ DAILY_SPEND_LIMIT: '1.50' }, [lead(), lead({ phone: '+15125550101', business_name: 'Second' })]);
  const id = await spend.store.insertCall(2);
  await spend.db.run('UPDATE calls SET cost_cents = 151, status = ? WHERE id = ?', 'completed', id);
  await enqueueLeads(spend.ctx, [1]);
  r = await runDue(spend.ctx);
  assert.equal(r.placed, false);
  assert.match((await placeCall(spend.ctx, 1)).error, /spend limit/);
  assert.equal(calls.length, 0);
});
