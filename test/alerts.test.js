// Hot-lead alerts to the owner, the "Needs you" list, and the follow-up email.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';
import { makeCtx, lead as makeLead } from './helpers.js';
import { sendDueFollowups } from '../src/core/notify.js';

const app = await startApp({
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'Fardin <hello@rhfardin.com>', ALERT_EMAIL: 'fardin@example.com',
  PUBLIC_URL: 'https://calls.example.com', AMD_ENABLED: 'false',
});
after(() => app.stop());
before(async () => assert.equal((await app.api('POST', '/api/login', { password: 'pw' })).status, 200));

let n = 0;
async function callWithOutcome(analysis) {
  const phone = `51255508${String(++n).padStart(2, '0')}`;
  await app.api('POST', '/api/import', { rows: [['Business', 'Phone', 'Owner', 'Redesign Link'], [`Spa ${n}`, phone, 'Sam', 'https://demo.test/x']] });
  const lead = (await app.api('GET', `/api/leads?q=${phone.slice(-4)}`)).body.leads[0];
  const before = app.fake.twilioCalls.length;
  await app.api('POST', `/api/leads/${lead.id}/call`, {});
  app.fake.analysis = analysis;
  app.fake.onSession = (ws) => ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Sure, tell me more.' }));
  const s = app.mediaStream(app.fake.twilioCalls[before]);
  await s.ready;
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0]?.status === 'in_progress');
  await new Promise((r) => setTimeout(r, 30));
  s.stop();
  await waitFor(async () => (await app.api('GET', `/api/leads/${lead.id}`)).body.calls[0].status === 'completed');
  return lead;
}

test('an interested business: instant email to Fardin and a "Needs you" entry', async () => {
  const emails = app.fake.emails.length;
  const lead = await callWithOutcome({ outcome: 'interested', summary: 'Liked the preview, wants pricing.', next_step: 'Email the price', requests: 'Online booking' });
  const mail = await waitFor(() => app.fake.emails[emails]);
  assert.deepEqual(mail.to, ['fardin@example.com']);
  assert.equal(mail.subject, `Interested: ${lead.business_name}`);
  assert.match(mail.text, /What happened: Liked the preview, wants pricing\./);
  assert.match(mail.text, /Next step: Email the price/);
  assert.match(mail.text, /They asked for: Online booking/);
  assert.match(mail.text, new RegExp(`https://calls\\.example\\.com/#lead-${lead.id}`));

  let needs = (await app.api('GET', '/api/needs-you')).body.leads;
  assert.ok(needs.some((l) => l.id === lead.id && l.hot_reason === 'Interested'));
  assert.equal((await app.api('GET', '/api/status')).body.needsYou, needs.length);
  await app.api('POST', `/api/leads/${lead.id}/handled`, {});
  needs = (await app.api('GET', '/api/needs-you')).body.leads;
  assert.ok(!needs.some((l) => l.id === lead.id), 'Done removes it');
});

test('not interested or no answer: no alert', async () => {
  const emails = app.fake.emails.length;
  await callWithOutcome({ outcome: 'not_interested', summary: 'Not interested.' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.fake.emails.length, emails);
});

test('a "yes" reads as "Said yes"', async () => {
  const emails = app.fake.emails.length;
  const lead = await callWithOutcome({ outcome: 'sold', summary: 'Agreed to go live at $750.' });
  const mail = await waitFor(() => app.fake.emails[emails]);
  assert.equal(mail.subject, `Said yes: ${lead.business_name}`);
});

test('follow-up emails need a postal address before they can be turned on', async () => {
  const r = await app.api('PUT', '/api/settings', { FOLLOWUP_DAYS: '3' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /postal address/);
  assert.equal((await app.api('PUT', '/api/settings', { FOLLOWUP_DAYS: '3', BUSINESS_ADDRESS: 'Rizer Web, 1 Main St, Cheyenne, WY 82001' })).status, 200);
});

test('the follow-up goes once, only to businesses still undecided', async () => {
  const { ctx, store, sent } = await makeCtx({ FOLLOWUP_DAYS: '3', BUSINESS_ADDRESS: 'Rizer Web, 1 Main St, Cheyenne, WY 82001', YOUR_NAME: 'Fardin' });
  await store.upsertLeads([
    makeLead({ phone: '+15125550901', business_name: 'Undecided', email: 'a@a.test' }),
    makeLead({ phone: '+15125550902', business_name: 'Said yes', email: 'b@b.test' }),
    makeLead({ phone: '+15125550903', business_name: 'Not due yet', email: 'c@c.test' }),
  ]);
  const past = new Date(Date.now() - 60000).toISOString();
  await store.updateLead(1, { status: 'interested', followup_due_at: past });
  await store.updateLead(2, { status: 'won', followup_due_at: past });
  await store.updateLead(3, { status: 'interested', followup_due_at: new Date(Date.now() + 864e5).toISOString() });
  assert.equal(await sendDueFollowups(ctx), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'a@a.test');
  assert.match(sent[0].text, /https:\/\/demo\.test\/bright/);
  assert.match(sent[0].text, /1 Main St, Cheyenne/);
  assert.match(sent[0].text, /reply "stop"/);
  assert.equal(await sendDueFollowups(ctx), 0, 'never twice');
});
