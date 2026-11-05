// Voicemail detection, retries and recordings on the real Node server.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, sleep } from './fakes.js';

const app = await startApp({ RECORD_CALLS: 'true' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

async function newLead(phone) {
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], [`Lead ${phone}`, phone, 'https://demo.test/x']] });
  return (await app.api('GET', `/api/leads?q=${phone.slice(-4)}`)).body.leads[0];
}
async function dial(lead) {
  const before = app.fake.twilioCalls.length;
  assert.equal((await app.api('POST', `/api/leads/${lead.id}/call`, {})).status, 200);
  const call = app.fake.twilioCalls[before];
  return { call, callId: call.Twiml.match(/name="callId" value="(\d+)"/)[1], sid: `CA${before + 1}` };
}

test('calls ask Twilio for voicemail detection and recording', async () => {
  const { call } = await dial(await newLead('5125550301'));
  assert.equal(call.MachineDetection, 'Enable');
  assert.equal(call.AsyncAmd, 'true');
  assert.match(call.AsyncAmdStatusCallback, /\/twilio\/amd\?call=\d+$/);
  assert.equal(call.Record, 'true');
});

test('the AI waits briefly before speaking, then turns normal replies on', async () => {
  const lead = await newLead('5125550302');
  const { call } = await dial(lead);
  const n = app.fake.sessionUpdates.length;
  const s = app.mediaStream(call);
  await s.ready;
  const first = await waitFor(() => app.fake.sessionUpdates[n]);
  assert.equal(first.audio.input.turn_detection.create_response, false);
  assert.deepEqual(first.audio.input.noise_reduction, { type: 'near_field' });
  assert.match(first.instructions, /this call is recorded/);
  const second = await waitFor(() => app.fake.sessionUpdates[n + 1], { timeout: 4000 });
  assert.equal(second.audio.input.turn_detection.create_response, true);
  s.stop();
});

test('voicemail detected during the call: hang up, mark voicemail, skip the analysis', async () => {
  const lead = await newLead('5125550303');
  const { call, callId, sid } = await dial(lead);
  const s = app.mediaStream(call);
  await s.ready;
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0].status === 'in_progress');
  assert.equal(await app.twilioPost(`/twilio/amd?call=${callId}`, { AnsweredBy: 'machine_start', CallSid: sid }), 200);
  await waitFor(() => app.fake.hangups.includes(sid));
  s.stop();
  const { body } = await waitFor(async () => {
    const r = await app.api('GET', `/api/leads/${lead.id}`);
    return r.body.calls[0].status === 'completed' && r;
  });
  assert.equal(body.lead.status, 'voicemail');
  assert.equal(body.calls[0].answered_by, 'machine_start');
  assert.equal(body.calls[0].outcome.outcome, 'voicemail');
});

test('voicemail detected before the AI connected is recorded too', async () => {
  const lead = await newLead('5125550304');
  const { callId, sid } = await dial(lead);
  assert.equal(await app.twilioPost(`/twilio/amd?call=${callId}`, { AnsweredBy: 'machine_end_beep', CallSid: sid }), 200);
  await app.twilioPost(`/twilio/status?call=${callId}`, { CallStatus: 'completed', CallSid: sid });
  const { body } = await app.api('GET', `/api/leads/${lead.id}`);
  assert.equal(body.lead.status, 'voicemail');
  assert.equal(body.calls[0].status, 'completed', 'not marked "audio never connected"');
});

test('a person answering is left alone', async () => {
  const lead = await newLead('5125550305');
  const { callId, sid } = await dial(lead);
  const hangups = app.fake.hangups.length;
  await app.twilioPost(`/twilio/amd?call=${callId}`, { AnsweredBy: 'human', CallSid: sid });
  await sleep(50);
  assert.equal(app.fake.hangups.length, hangups);
});

test('recordings are saved and can be played from the dashboard', async () => {
  const lead = await newLead('5125550306');
  const { callId } = await dial(lead);
  await app.twilioPost(`/twilio/recording?call=${callId}`, { RecordingSid: 'RE123', RecordingStatus: 'completed' });
  const res = await app.realFetch(`${app.base}/api/calls/${callId}/recording`, { headers: { cookie: (await loginCookie()) } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await res.arrayBuffer()).byteLength, 3);
});

async function loginCookie() {
  const r = await app.realFetch(`${app.base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ password: 'pw' }),
  });
  return r.headers.get('set-cookie').split(';')[0];
}
