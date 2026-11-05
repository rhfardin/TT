// Booking calls with the owner in Cal.com during the conversation.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';
import { parseSlots } from '../src/core/calcom.js';

const app = await startApp({
  YOUR_NAME: 'Fardin', AMD_ENABLED: 'false',
  CALCOM_API_KEY: 'cal_test', CALCOM_USERNAME: 'fardin', CALCOM_EVENT_SLUG: '15min',
});
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

// Open times: tomorrow and the day after at 15:00, 16:00 and 17:00 UTC.
const day = (n, h) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + n, h)).toISOString();
app.fake.calcom.slots = [day(1, 15), day(1, 16), day(1, 17), day(2, 15), day(2, 16), day(3, 15), day(4, 15)];

test('parseSlots reads both shapes Cal.com has used', () => {
  assert.deepEqual(parseSlots({ data: { '2026-11-10': [{ start: '2026-11-10T15:00:00.000Z' }] } }), ['2026-11-10T15:00:00.000Z']);
  assert.deepEqual(parseSlots({ data: { slots: { '2026-11-10': [{ time: '2026-11-10T10:00:00-05:00' }] } } }), ['2026-11-10T15:00:00.000Z']);
  assert.deepEqual(parseSlots({ data: { '2026-11-10': ['2026-11-10T15:00:00Z'] } }), ['2026-11-10T15:00:00.000Z']);
});

async function call(script) {
  const phone = `5125550${700 + Math.floor(Math.random() * 99)}`;
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Owner', 'Redesign Link'], ['Glow Spa', phone, 'Sam', 'https://demo.test/x']] });
  const lead = (await app.api('GET', `/api/leads?q=${phone.slice(-4)}`)).body.leads[0];
  const before = app.fake.twilioCalls.length;
  await app.api('POST', `/api/leads/${lead.id}/call`, {});
  const sessions = app.fake.sessionUpdates.length;
  app.fake.onSession = script;
  const s = app.mediaStream(app.fake.twilioCalls[before]);
  await s.ready;
  return { lead, s, session: await waitFor(() => app.fake.sessionUpdates[sessions]) };
}
const toolCall = (ws, name, args, id) => ws.send(JSON.stringify({ type: 'response.done', response: { output: [
  { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) },
] } }));
const toolResult = (id) => waitFor(() => {
  const e = app.fake.fromAI.find((x) => x.item?.type === 'function_call_output' && x.item.call_id === id);
  return e && JSON.parse(e.item.output);
});

test('with Cal.com set up, the AI gets the booking tools and instructions', async () => {
  const { session, s } = await call(null);
  assert.ok(session.tools.some((t) => t.name === 'check_availability'));
  assert.ok(session.tools.some((t) => t.name === 'book_meeting'));
  assert.match(session.instructions, /Booking a call with Fardin/);
  assert.match(session.instructions, /book a quick call with Fardin/); // instead of "he calls you back"
  s.stop();
});

test('the AI checks open times and books one; Cal.com gets the right details', async () => {
  const { lead, s } = await call((ws) => toolCall(ws, 'check_availability', {}, 'a1'));
  const avail = await toolResult('a1');
  assert.equal(avail.ok, true);
  assert.deepEqual(avail.times.map((t) => t.start), [day(1, 15), day(1, 16), day(2, 15), day(2, 16), day(3, 15)], 'two per day, three days');
  assert.match(avail.times[0].say, /at (9|10):00 AM$/, 'said in the business\'s own time (Austin is UTC-6 or UTC-5)');
  const slotsReq = app.fake.calcom.requests.find((r) => r.url.includes('/v2/slots?'));
  assert.equal(slotsReq.headers['cal-api-version'], '2024-09-04');
  assert.equal(slotsReq.headers.Authorization, 'Bearer cal_test');
  assert.equal(new URL(slotsReq.url).searchParams.get('timeZone'), 'America/Chicago');

  toolCall(app.fake.openaiSocket, 'book_meeting', { start: avail.times[1].start, name: 'Sam', email: 'sam@glow.test' }, 'b1');
  const booked = await toolResult('b1');
  assert.equal(booked.ok, true, JSON.stringify(booked));
  const b = app.fake.calcom.bookings.at(-1);
  assert.equal(b.start, day(1, 16));
  assert.deepEqual(b.attendee, { name: 'Sam', email: 'sam@glow.test', timeZone: 'America/Chicago', phoneNumber: lead.phone });
  assert.equal(b.eventTypeSlug, '15min');
  assert.equal(b.username, 'fardin');
  const { body } = await app.api('GET', `/api/leads/${lead.id}`);
  assert.match(body.lead.meeting_time, /at (10|11):00 AM$/);
  assert.equal(body.lead.email, 'sam@glow.test');
  s.stop();
});

test('a time the calendar doesn\'t have is refused, and a missing email is asked for', async () => {
  const { s } = await call((ws) => toolCall(ws, 'book_meeting', { start: day(1, 13), email: 'sam@glow.test' }, 'c1'));
  assert.match((await toolResult('c1')).message, /isn't open/);
  toolCall(app.fake.openaiSocket, 'book_meeting', { start: day(1, 15) }, 'c2');
  assert.match((await toolResult('c2')).message, /Ask for their email/);
  s.stop();
});

test('if Cal.com fails, the AI falls back to a callback', async () => {
  app.fake.calcom.fail = 'Invalid API key';
  const { s } = await call((ws) => toolCall(ws, 'check_availability', {}, 'd1'));
  const r = await toolResult('d1');
  assert.equal(r.ok, false);
  assert.match(r.message, /calls them back/);
  assert.match((await app.api('POST', '/api/setup/calcom', {})).body.error, /Invalid API key/);
  app.fake.calcom.fail = null;
  s.stop();
});

test('"Test connection" in Settings reports the first open time', async () => {
  const r = await app.api('POST', '/api/setup/calcom', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 7);
  assert.match(r.body.next, /at/);
});
