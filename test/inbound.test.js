// Businesses calling our number back, answered by the AI.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';

const app = await startApp({ YOUR_NAME: 'Fardin', AGENT_NAME: 'Alex', PUBLIC_URL: 'https://calls.example.com' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

let sid = 0;
async function callIn(from) {
  const CallSid = `CAin${++sid}`;
  assert.equal(await app.twilioPost('/twilio/inbound', { From: from, To: '+15550000000', CallSid, CallStatus: 'ringing' }), 200);
  return { twiml: app.fake.lastTwiml, CallSid };
}

test('a business from the list calls back: the AI knows who it is and answers first', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], ['Bright Smile Dental', '512-555-0600', 'https://demo.test/b']] });
  const lead = (await app.api('GET', '/api/leads')).body.leads[0];
  // Only tomorrow is a calling day, so their queued call waits instead of going out now.
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(new Date());
  const tomorrow = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(today) + 1) % 7 + 1;
  assert.equal((await app.api('PUT', '/api/settings', { CALL_DAYS: String(tomorrow) })).status, 200);
  await app.api('POST', '/api/call-batch', { ids: [lead.id] });
  assert.ok((await app.api('GET', `/api/leads/${lead.id}`)).body.lead.next_call_at, 'a call is waiting for them');

  const { twiml, CallSid } = await callIn('(512) 555-0600');
  assert.match(twiml, /<Connect><Stream url="wss:\/\/calls\.example\.com\/media-stream\/\d+">/);
  const updates = app.fake.sessionUpdates.length;
  const replies = app.fake.fromAI.filter((e) => e.type === 'response.create').length;
  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Yeah I got your email about the site.' }));
  };
  app.fake.analysis = { outcome: 'interested', summary: 'Called back, liked the preview.' };
  const s = app.mediaStream({ Twiml: twiml }, { callSid: CallSid });
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[updates]);
  assert.match(session.instructions, /This is an incoming call/);
  assert.match(session.instructions, /thanks for calling back/);
  assert.match(session.instructions, /Bright Smile Dental/);
  assert.equal(session.audio.input.turn_detection.create_response, true, 'no voicemail pause for callers');
  await waitFor(() => app.fake.fromAI.filter((e) => e.type === 'response.create').length > replies, { timeout: 1000 });
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0]?.status === 'in_progress');
  s.stop();

  const { body } = await waitFor(async () => {
    const r = await app.api('GET', `/api/leads/${lead.id}`);
    return r.body.calls[0].status === 'completed' && r;
  });
  assert.equal(body.calls[0].direction, 'inbound');
  assert.equal(body.lead.status, 'interested');
  assert.equal(body.lead.attempts, 0, 'callbacks are not counted as tries');
  assert.equal(body.lead.next_call_at, null, 'the waiting call was cancelled');
  await app.api('PUT', '/api/settings', { CALL_DAYS: '1,2,3,4,5,6,7' });
});

test('an unknown number: the AI finds out who it is, and the lead gets their business name', async () => {
  const { twiml, CallSid } = await callIn('+13105550777');
  const updates = app.fake.sessionUpdates.length;
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hi, this is Glow Med Spa.' }));
  app.fake.analysis = { outcome: 'callback', summary: 'Owner of Glow Med Spa wants a call back.', business_name: 'Glow Med Spa' };
  const s = app.mediaStream({ Twiml: twiml }, { callSid: CallSid });
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[updates]);
  assert.match(session.instructions, /from a number we don't know/);
  assert.match(session.instructions, /thanks for calling Fardin/);
  await waitFor(async () => (await app.api('GET', '/api/leads?q=0777')).body.leads[0]?.business_name === 'Unknown caller');
  s.stop();
  const lead = await waitFor(async () => {
    const l = (await app.api('GET', '/api/leads?q=0777')).body.leads[0];
    return l.status === 'callback' && l;
  });
  assert.equal(lead.business_name, 'Glow Med Spa');
});

test('a hidden number is still answered', async () => {
  const { twiml } = await callIn('anonymous');
  assert.match(twiml, /<Connect><Stream/);
});

test('someone who hangs up straight away changes nothing', async () => {
  const { twiml, CallSid } = await callIn('(512) 555-0600');
  const before = (await app.api('GET', '/api/leads?q=0600')).body.leads[0];
  app.fake.onSession = null;
  const s = app.mediaStream({ Twiml: twiml }, { callSid: CallSid });
  await s.ready;
  await waitFor(async () => (await app.api('GET', `/api/leads/${before.id}`)).body.calls[0]?.status === 'in_progress');
  s.stop();
  await waitFor(async () => (await app.api('GET', `/api/leads/${before.id}`)).body.calls[0].status === 'completed');
  assert.equal((await app.api('GET', `/api/leads/${before.id}`)).body.lead.status, before.status);
});

test('unsigned requests to the incoming-call address are refused', async () => {
  const r = await app.realFetch(`${app.base}/twilio/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'From=%2B15125550600&CallSid=CAx' });
  assert.equal(r.status, 403);
});

test('"Set it up for me" points the Twilio number at the AI', async () => {
  const r = await app.api('POST', '/api/setup/inbound', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(app.fake.numberUpdates.at(-1), {
    VoiceUrl: 'https://calls.example.com/twilio/inbound', VoiceMethod: 'POST',
    StatusCallback: 'https://calls.example.com/twilio/status-inbound', StatusCallbackMethod: 'POST',
  });
});

test('withheld numbers (Twilio\'s +266696687 "anonymous") are never merged into one lead', async () => {
  await callIn('+266696687');
  await callIn('+266696687');
  const hidden = (await app.api('GET', '/api/leads?limit=200')).body.leads.filter((l) => l.phone.startsWith('hidden:'));
  assert.ok(hidden.length >= 3, `each hidden caller is separate (got ${hidden.length})`);
  // ...and a hidden caller can never be dialled.
  const r = await app.api('POST', `/api/leads/${hidden[0].id}/call`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /hidden number/);
});

test('a customer who already said yes stays "won" when they call in', async () => {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone'], ['Happy Customer', '512-555-0650']] });
  const lead = (await app.api('GET', '/api/leads?q=0650')).body.leads[0];
  await app.api('PATCH', `/api/leads/${lead.id}`, { status: 'won' });
  const { twiml, CallSid } = await callIn('(512) 555-0650');
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Quick question about the site.' }));
  app.fake.analysis = { outcome: 'callback', summary: 'Had a question.' };
  const s = app.mediaStream({ Twiml: twiml }, { callSid: CallSid });
  await s.ready;
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0]?.status === 'in_progress');
  await new Promise((r) => setTimeout(r, 50));
  s.stop();
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0].status === 'completed');
  assert.equal((await app.api('GET', `/api/leads/${lead.id}`)).body.lead.status, 'won');
});
