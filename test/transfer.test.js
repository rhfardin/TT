// Live transfer to the owner's phone, on the real Node server with fake Twilio and OpenAI.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor, sleep } from './fakes.js';

const app = await startApp({ TRANSFER_ENABLED: 'true', TRANSFER_PHONE: '+15559990000', YOUR_NAME: 'Fardin', AMD_ENABLED: 'false' });
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

let n = 0;
async function startCall() {
  const phone = `51255504${String(++n).padStart(2, '0')}`;
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], [`Glow & Co Spa ${n}`, phone, 'https://demo.test/x']] });
  const lead = (await app.api('GET', `/api/leads?q=${phone.slice(-4)}`)).body.leads[0];
  const before = app.fake.twilioCalls.length;
  assert.equal((await app.api('POST', `/api/leads/${lead.id}/call`, {})).status, 200);
  const twilioCall = app.fake.twilioCalls[before];
  const callId = twilioCall.Twiml.match(/name="callId" value="(\d+)"/)[1];
  return { lead, twilioCall, callId, sid: `CA${before + 1}` };
}

// The fake model: hears the owner ask for Fardin, says "one sec", calls the transfer tool.
function askForFardin(ws) {
  ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Can I talk to Fardin?' }));
  ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'i1', delta: Buffer.alloc(800).toString('base64') }));
  ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Sure, one sec, let me grab him.' }));
  ws.send(JSON.stringify({ type: 'response.done', response: { output: [
    { type: 'function_call', name: 'transfer_to_fardin', call_id: 't1', arguments: JSON.stringify({ summary: 'Owner Sam <wants> to talk price & timing' }) },
  ] } }));
}

async function transferStarted(s, callId) {
  await waitFor(() => app.fake.updates.length > s.updatesBefore);
  const call = (await app.api('GET', `/api/leads/${s.lead.id}`)).body.calls[0];
  return { update: app.fake.updates.at(-1), call };
}

test('the transfer tool and instructions are offered only when live transfer is on', async () => {
  const c = await startCall();
  const before = app.fake.sessionUpdates.length;
  app.fake.onSession = null;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[before]);
  assert.ok(session.tools.some((t) => t.name === 'transfer_to_fardin'));
  assert.match(session.instructions, /Talking to Fardin live/);
  assert.match(session.instructions, /Only if they ask/);
  s.stop();
});

test('owner asks for Fardin: the call is handed to his phone after "one sec" has played', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  const updatesBefore = app.fake.updates.length;
  const s = app.mediaStream(c.twilioCall, { autoAck: false });
  await s.ready;
  await waitFor(() => s.received.some((m) => m.event === 'mark' && m.mark.name === 'transfer'));
  await sleep(50);
  assert.equal(app.fake.updates.length, updatesBefore, 'waits for the goodbye line to play');
  s.ws.send(JSON.stringify({ event: 'mark', mark: { name: 'transfer' } }));
  const { update, call } = await transferStarted({ ...c, updatesBefore }, c.callId);
  assert.equal(update.sid, c.sid);
  assert.match(update.twiml, /<Dial callerId="\+15550000000" timeout="20" action="http:\/\/localhost:3000\/twilio\/transfer-result\?call=\d+">/);
  assert.match(update.twiml, /<Number url="http:\/\/localhost:3000\/twilio\/whisper\?call=\d+">\+15559990000<\/Number>/);
  assert.equal(call.status, 'transferring');
  assert.equal(call.transcript.length, 2, 'conversation so far saved');
  s.stop();
  await sleep(100);
  assert.equal((await app.api('GET', `/api/leads/${c.lead.id}`)).body.calls[0].status, 'transferring', 'not finished by the stream closing');

  // Fardin hears the summary and presses 1; they talk for 4 minutes.
  await app.twilioPost(`/twilio/whisper?call=${c.callId}`, { CallSid: 'CAfardin' });
  assert.match(app.fake.lastTwiml, /<Gather numDigits="1"/);
  assert.match(app.fake.lastTwiml, /Glow &amp; Co Spa \d+\. Owner Sam &lt;wants&gt; to talk price &amp; timing/);
  await app.twilioPost(`/twilio/whisper-answer?call=${c.callId}`, { Digits: '1' });
  assert.equal(app.fake.lastTwiml, '<Response/>');
  await app.twilioPost(`/twilio/transfer-result?call=${c.callId}`, { DialCallStatus: 'completed', DialCallDuration: '240' });
  assert.match(app.fake.lastTwiml, /<Hangup\/>/);
  const { body } = await app.api('GET', `/api/leads/${c.lead.id}`);
  assert.equal(body.calls[0].status, 'completed');
  assert.equal(body.calls[0].outcome.outcome, 'transferred');
  assert.match(body.calls[0].summary, /^Connected to Fardin for 4 min/);
  assert.equal(body.lead.status, 'interested');

  // A late "completed" status for the same call changes nothing.
  await app.twilioPost(`/twilio/status?call=${c.callId}`, { CallStatus: 'completed', CallDuration: '300' });
  assert.equal((await app.api('GET', `/api/leads/${c.lead.id}`)).body.calls.length, 1);
});

test('Fardin doesn\'t press 1: the AI comes back, apologizes and carries on', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  const updatesBefore = app.fake.updates.length;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  await transferStarted({ ...c, updatesBefore }, c.callId);
  s.stop();

  await app.twilioPost(`/twilio/whisper-answer?call=${c.callId}`, { Digits: '' });
  assert.match(app.fake.lastTwiml, /<Hangup\/>/);
  await app.twilioPost(`/twilio/transfer-result?call=${c.callId}`, { DialCallStatus: 'completed' });
  const resumeTwiml = app.fake.lastTwiml;
  assert.match(resumeTwiml, /<Connect><Stream url="ws:\/\/localhost:3000\/media-stream\/\d+">/);
  assert.match(resumeTwiml, /name="resume" value="1"/);

  const sessionsBefore = app.fake.sessionUpdates.length;
  const repliesBefore = app.fake.fromAI.filter((e) => e.type === 'response.create').length;
  app.fake.onSession = null;
  const back = app.mediaStream({ Twiml: resumeTwiml }, { callSid: c.sid });
  await back.ready;
  const session = await waitFor(() => app.fake.sessionUpdates[sessionsBefore]);
  assert.match(session.instructions, /Picking the call back up/);
  assert.match(session.instructions, /Them: Can I talk to Fardin\?/);
  assert.ok(!session.tools.some((t) => t.name === 'transfer_to_fardin'), 'no second transfer');
  await waitFor(() => app.fake.fromAI.filter((e) => e.type === 'response.create').length > repliesBefore, { timeout: 1000 });

  // The same resume stream can't be used twice.
  const replay = app.mediaStream({ Twiml: resumeTwiml }, { callSid: c.sid });
  await replay.ready;
  await waitFor(() => replay.ws.readyState === 3);

  back.stop();
  const { body } = await waitFor(async () => {
    const r = await app.api('GET', `/api/leads/${c.lead.id}`);
    return r.body.calls[0].status === 'completed' && r;
  });
  assert.equal(body.calls[0].transfer_state, 'missed');
  assert.ok(body.calls[0].transcript.length >= 2, 'transcript kept from before the transfer');
});

test('if Twilio refuses the transfer, the AI is told and keeps the call', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  app.fake.failUpdates = true;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  const out = await waitFor(() => app.fake.fromAI.find((e) => e.item?.call_id === 't1' && e.item?.type === 'function_call_output' && JSON.parse(e.item.output).ok === false));
  assert.match(JSON.parse(out.item.output).message, /didn't go through/);
  app.fake.failUpdates = false;
  assert.equal((await app.api('GET', `/api/leads/${c.lead.id}`)).body.calls[0].status, 'in_progress');
  s.stop();
});

test('the owner hangs up while Fardin\'s phone rings: recorded once, as a callback', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  const updatesBefore = app.fake.updates.length;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  await transferStarted({ ...c, updatesBefore }, c.callId);
  s.stop();
  app.fake.analysis = { outcome: 'interested', summary: 'Wanted to talk to Fardin about price.' };
  await Promise.all([
    app.twilioPost(`/twilio/status?call=${c.callId}`, { CallStatus: 'completed', CallDuration: '90' }),
    app.twilioPost(`/twilio/status?call=${c.callId}`, { CallStatus: 'completed', CallDuration: '90' }),
  ]);
  const { body } = await app.api('GET', `/api/leads/${c.lead.id}`);
  assert.equal(body.calls[0].status, 'completed');
  assert.match(body.calls[0].summary, /hung up while being connected/);
  assert.match(body.calls[0].outcome.next_step, /Call them back/);
  assert.equal(body.events.filter((e) => e.kind === 'call_completed').length, 1);
});

test('like real Twilio, the stream closes the moment the call moves to Fardin: still a transfer', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  const updatesBefore = app.fake.updates.length;
  const s = app.mediaStream(c.twilioCall);
  app.fake.onUpdate = () => s.stop(); // Twilio ends the stream right away
  await s.ready;
  const { update } = await transferStarted({ ...c, updatesBefore }, c.callId);
  app.fake.onUpdate = null;
  assert.equal(update.body.TimeLimit, '14400', 'the owner\'s conversation isn\'t cut off at the AI\'s time limit');
  await sleep(150);
  let call = (await app.api('GET', `/api/leads/${c.lead.id}`)).body.calls[0];
  assert.equal(call.status, 'transferring', 'not recorded as a normal finished call');
  // Fardin misses it: the AI comes back (not a hang-up).
  await app.twilioPost(`/twilio/transfer-result?call=${c.callId}`, { DialCallStatus: 'no-answer' });
  assert.match(app.fake.lastTwiml, /name="resume" value="1"/);
});

test('a connected transfer is answered right away and costed with the owner\'s minutes', async () => {
  const c = await startCall();
  app.fake.onSession = askForFardin;
  const updatesBefore = app.fake.updates.length;
  const s = app.mediaStream(c.twilioCall);
  await s.ready;
  await transferStarted({ ...c, updatesBefore }, c.callId);
  s.stop();
  await app.twilioPost(`/twilio/whisper-answer?call=${c.callId}`, { Digits: '1' });
  await app.twilioPost(`/twilio/transfer-result?call=${c.callId}`, { DialCallStatus: 'completed', DialCallDuration: '125' });
  assert.match(app.fake.lastTwiml, /<Hangup\/>/);
  const call = await waitFor(async () => {
    const x = (await app.api('GET', `/api/leads/${c.lead.id}`)).body.calls[0];
    return x.status === 'completed' && x;
  });
  assert.ok(call.duration_secs >= 0);
  assert.ok(call.cost_cents >= 3 * 1.4, `owner leg (3 min) costed, got ${call.cost_cents}`);
});
