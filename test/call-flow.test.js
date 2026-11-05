// A whole outbound call on the Node server, with Twilio, OpenAI and email faked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';

const app = await startApp();
after(() => app.stop());

test('import, call, talk, hang up, save the result', async () => {
  assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200);
  const imp = await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Redesign Link'], ['Test Dental', '512-555-0100', 'https://demo.test/a']] });
  assert.equal(imp.body.imported, 1);

  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello?' }));
    ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'it1', delta: 'AAAA' }));
    ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Hi, this is Alex, an AI assistant.' }));
    ws.send(JSON.stringify({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'end_call', call_id: 'c1', arguments: '{"reason":"finished"}' }] } }));
  };
  const { body: leads } = await app.api('GET', '/api/leads');
  const call = await app.api('POST', `/api/leads/${leads.leads[0].id}/call`, {});
  assert.equal(call.status, 200, JSON.stringify(call.body));

  const stream = app.mediaStream(app.fake.twilioCalls[0]);
  await stream.ready;
  stream.media(3);
  await waitFor(() => app.fake.hangups.length > 0);
  stream.stop();

  const lead = await waitFor(async () => {
    const r = await app.api('GET', `/api/leads/${leads.leads[0].id}`);
    return r.body.calls[0]?.status === 'completed' && r.body;
  });
  assert.equal(lead.lead.status, 'interested');
  assert.equal(lead.calls[0].outcome.outcome, 'link_sent');
  assert.deepEqual(lead.calls[0].transcript.map((t) => t.role), ['user', 'agent']);
  assert.ok(app.fake.sessionUpdates[0].instructions.includes('Test Dental'));
});

test('a media stream with a bad token is rejected', async () => {
  const s = app.mediaStream({ Twiml: app.fake.twilioCalls[0].Twiml.replace(/name="token" value="[^"]+"/, 'name="token" value="nope"') });
  await s.ready;
  await waitFor(() => s.ws.readyState === 3);
});

async function newLead(phone, extra = {}) {
  const rows = [['Business', 'Phone', 'Redesign Link'], [extra.name || `Lead ${phone}`, phone, extra.demo ?? 'https://demo.test/x']];
  await app.api('POST', '/api/import', { rows });
  const { body } = await app.api('GET', `/api/leads?q=${encodeURIComponent(phone.slice(-4))}`);
  return body.leads[0];
}
async function dial(lead) {
  const before = app.fake.twilioCalls.length;
  const r = await app.api('POST', `/api/leads/${lead.id}/call`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return app.fake.twilioCalls[before];
}
const audio = (ms) => Buffer.alloc(ms * 8).toString('base64'); // 8 bytes per ms of mu-law

test('talking over the AI stops its audio even after the reply finished generating', async () => {
  const lead = await newLead('5125550201');
  app.fake.onSession = (ws) => {
    ws.send(JSON.stringify({ type: 'response.output_audio.delta', item_id: 'it9', delta: audio(2000) }));
    ws.send(JSON.stringify({ type: 'response.done', response: { output: [] } })); // generation done, audio still playing
  };
  const s = app.mediaStream(await dial(lead), { autoAck: false });
  await s.ready;
  s.media(1);
  await waitFor(() => s.received.some((m) => m.event === 'media'));
  s.media(25); // 500 ms of the AI's audio has played
  await new Promise((r) => setTimeout(r, 50));
  app.fake.openaiSocket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
  await waitFor(() => s.received.some((m) => m.event === 'clear'));
  const truncate = await waitFor(() => app.fake.fromAI.find((e) => e.type === 'conversation.item.truncate' && e.item_id === 'it9'));
  assert.equal(truncate.audio_end_ms, 500);
  s.stop();
});

test('hanging up while the AI is still connecting closes the AI session', async () => {
  const lead = await newLead('5125550202');
  app.fake.onSession = null;
  app.fake.connectDelayMs = 300;
  const updatesBefore = app.fake.sessionUpdates.length;
  const s = app.mediaStream(await dial(lead));
  await s.ready;
  s.stop();
  await new Promise((r) => setTimeout(r, 600));
  app.fake.connectDelayMs = 0;
  assert.equal(app.fake.sessionUpdates.length, updatesBefore, 'no session configured');
  assert.equal(app.fake.openaiSocket.readyState, 3, 'socket closed');
});

test('a finished call\'s stream cannot be replayed', async () => {
  const connections = app.fake.connections;
  const s = app.mediaStream(app.fake.twilioCalls[0]); // the first test's call, long finished, valid token
  await s.ready;
  await waitFor(() => s.ws.readyState === 3);
  assert.equal(app.fake.connections, connections);
});

test('the AI cannot text a number of its choosing, and no preview link means no message', async () => {
  const lead = await newLead('5125550203');
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'response.done', response: { output: [
    { type: 'function_call', name: 'send_demo_link', call_id: 'c1', arguments: JSON.stringify({ channel: 'sms', phone: '+19995550000' }) },
  ] } }));
  const s = app.mediaStream(await dial(lead));
  await s.ready;
  await waitFor(() => app.fake.sms.length === 1);
  assert.equal(app.fake.sms[0].To, '+15125550203');
  s.stop();

  const noDemo = await newLead('5125550204', { demo: '' });
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'response.done', response: { output: [
    { type: 'function_call', name: 'send_demo_link', call_id: 'c2', arguments: '{"channel":"email","email":"a@b.test"}' },
  ] } }));
  const s2 = app.mediaStream(await dial(noDemo));
  await s2.ready;
  const out = await waitFor(() => app.fake.fromAI.find((e) => e.item?.call_id === 'c2'));
  assert.match(JSON.parse(out.item.output).message, /no preview link/);
  s2.stop();
});

test('an answered call whose audio never connects is marked failed, not left "calling"', async () => {
  const lead = await newLead('5125550205');
  const call = await dial(lead);
  const callId = call.Twiml.match(/name="callId" value="(\d+)"/)[1];
  assert.equal(await app.twilioPost(`/twilio/status?call=${callId}`, { CallStatus: 'completed', CallSid: 'CAx' }), 200);
  const { body } = await app.api('GET', `/api/leads/${lead.id}`);
  assert.equal(body.calls[0].status, 'failed');
  assert.match(body.calls[0].error, /never connected/);
  assert.equal(body.lead.status, 'no_answer');
});
