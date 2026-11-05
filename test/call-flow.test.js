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
