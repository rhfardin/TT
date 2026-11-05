// Calling back at a time the business picks, phone menus, and hanging up on dead air.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, sleep } from './fakes.js';
import { localDate, zonedDate } from '../src/core/leads.js';

const app = await startApp({ AMD_ENABLED: 'false', SILENCE_SECONDS: '1', YOUR_NAME: 'Fardin' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

let n = 0;
// A Los Angeles business (310 area code), called now.
async function startCall() {
  const phone = `31055507${String(++n).padStart(2, '0')}`;
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], [`LA Spa ${n}`, phone, 'https://demo.test/x']] });
  const lead = (await app.api('GET', `/api/leads?q=${phone.slice(-4)}`)).body.leads[0];
  const before = app.fake.twilioCalls.length;
  assert.equal((await app.api('POST', `/api/leads/${lead.id}/call`, {})).status, 200);
  return { lead, twilioCall: app.fake.twilioCalls[before], sid: `CA${before + 1}` };
}
const toolOutput = (callId) => waitFor(() => {
  const e = app.fake.fromAI.find((x) => x.type === 'conversation.item.create' && x.item?.call_id === callId);
  return e && JSON.parse(e.item.output);
});
const callTool = (name, callId, args) => ({ type: 'response.done', response: { output: [{ type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }] } });
const leadState = async (id) => (await app.api('GET', `/api/leads/${id}`)).body;

test('"call me back Thursday at 3": booked at 3 pm their time, and kept after the call', async () => {
  const c = await startCall();
  const day = localDate('America/Los_Angeles', new Date(Date.now() + 2 * 864e5));
  const sessions = app.fake.sessionUpdates.length;
  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Busy now, call me back in two days at 3.' }));
    ws.send(JSON.stringify(callTool('schedule_callback', 'cb-late', { when: `${day} 22:00` })));
    ws.send(JSON.stringify(callTool('schedule_callback', 'cb1', { when: `${day} 15:00`, note: 'ask for Dana' })));
  };
  app.fake.analysis = { outcome: 'callback', summary: 'Asked for a call back.', meeting_time: 'in two days' };
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[sessions]);
  assert.match(session.instructions, /Calling back at a time they pick/);
  assert.match(session.instructions, /Right now it is \w+day, /);
  assert.ok(session.tools.some((t) => t.name === 'schedule_callback'));
  assert.match((await toolOutput('cb-late')).message, /8 am and 8 pm/);
  assert.equal((await toolOutput('cb1')).ok, true);
  const expected = zonedDate(day, 15, 0, 'America/Los_Angeles').toISOString();
  assert.equal((await leadState(c.lead.id)).lead.next_call_at, expected);

  s.stop();
  const body = await waitFor(async () => { const b = await leadState(c.lead.id); return b.calls[0].status === 'completed' && b; });
  assert.equal(body.lead.status, 'callback');
  assert.equal(body.lead.next_call_at, expected, 'the call ending doesn\'t cancel it');
  assert.match(body.lead.meeting_time, /^Call back \w+day, .* 3:00 PM \(their time\) · ask for Dana$/);
});

test('a call-back time only mentioned in the conversation is booked from the summary', async () => {
  const c = await startCall();
  const day = localDate('America/Los_Angeles', new Date(Date.now() + 3 * 864e5));
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Try me later in the week, around 10.' }));
  app.fake.analysis = { outcome: 'callback', summary: 'Call back later.', callback_at: `${day} 10:00` };
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  await waitFor(async () => (await leadState(c.lead.id)).calls[0]?.transcript.length);
  s.stop();
  const body = await waitFor(async () => { const b = await leadState(c.lead.id); return b.calls[0].status === 'completed' && b; });
  assert.equal(body.lead.next_call_at, zonedDate(day, 10, 0, 'America/Los_Angeles').toISOString());
});

test('phone menu: the AI presses 1, Twilio plays it, and the AI picks the call back up', async () => {
  const c = await startCall();
  const sessions = app.fake.sessionUpdates.length;
  const updates = app.fake.updates.length;
  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'For appointments press 1. For all other questions press 2.' }));
    ws.send(JSON.stringify(callTool('press_keys', 'k1', { digits: '2' })));
  };
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  const first = await waitFor(() => app.fake.sessionUpdates[sessions]);
  assert.match(first.instructions, /# Phone menus/);
  const update = (await waitFor(() => app.fake.updates.length > updates && app.fake.updates)).at(-1);
  assert.equal(update.sid, c.sid);
  assert.match(update.twiml, /^<Response><Play digits="2"\/><Connect><Stream /);
  assert.match(update.twiml, /<Parameter name="resume" value="keys"\/>/);
  assert.equal((await leadState(c.lead.id)).calls[0].status, 'pressing_keys');
  s.stop();
  await sleep(100);
  assert.equal((await leadState(c.lead.id)).calls[0].status, 'pressing_keys', 'not finished by the old stream closing');

  // Twilio connects the new stream; a receptionist answers.
  const creates = app.fake.fromAI.filter((e) => e.type === 'response.create').length;
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Front desk, this is Kim.' }));
  app.fake.analysis = { outcome: 'callback', summary: 'Reached the front desk.' };
  const s2 = app.mediaStream({ Twiml: update.twiml }, { callSid: c.sid });
  await s2.ready;
  const resumed = await waitFor(() => app.fake.sessionUpdates[sessions + 1]);
  assert.match(resumed.instructions, /You just pressed 2 in their phone menu/);
  assert.match(resumed.instructions, /For appointments press 1/, 'knows what was said before');
  await waitFor(async () => (await leadState(c.lead.id)).calls[0].status === 'in_progress');
  await sleep(50);
  assert.equal(app.fake.fromAI.filter((e) => e.type === 'response.create').length, creates, 'listens first instead of talking over hold music');
  s2.stop();
  const body = await waitFor(async () => { const b = await leadState(c.lead.id); return b.calls[0].status === 'completed' && b; });
  const lines = body.calls[0].transcript.map((t) => t.message);
  assert.deepEqual(lines, ['For appointments press 1. For all other questions press 2.', '(pressed 2 in their phone menu)', 'Front desk, this is Kim.']);
});

test('a replayed key-press stream is turned away', async () => {
  const c = await startCall();
  app.fake.onSession = null;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  await waitFor(async () => (await leadState(c.lead.id)).calls[0]?.status === 'in_progress');
  // Same call, but nobody pressed anything: a stream claiming to resume after a key press is refused.
  const fake = c.twilioCall.Twiml.replace('</Stream>', '<Parameter name="resume" value="keys"/></Stream>');
  const before = app.fake.sessionUpdates.length;
  const s2 = app.mediaStream({ Twiml: fake }, { callSid: c.sid });
  await s2.ready;
  await sleep(150);
  assert.equal(app.fake.sessionUpdates.length, before);
  s.stop();
});

test('dead air: after the silence limit the AI says goodbye, then hangs up', async () => {
  const c = await startCall();
  app.fake.onSession = null; // nobody ever says anything
  const from = app.fake.fromAI.length;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  const prompt = await waitFor(() => app.fake.fromAI.slice(from).find((e) => e.type === 'response.create' && /lost you/.test(e.response?.instructions || '')), { timeout: 8000 });
  assert.ok(prompt);
  await waitFor(() => app.fake.hangups.includes(c.sid), { timeout: 6000 });
  s.stop();
});
