// Hot-lead alerts to the owner, the "Needs you" list, and the follow-up email.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitFor } from './fakes.js';
import { makeCtx, lead as makeLead } from './helpers.js';
import { sendDueFollowups, notifyOwner, sendMorningSummary, webhookSecret } from '../src/core/notify.js';
import { hmacHex } from '../src/core/crypto.js';
import { localDate, zonedDate } from '../src/core/leads.js';

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

test('follow-ups: skipped once handled; a failed send is retried later, and given up after 5 tries', async () => {
  const { ctx, store } = await makeCtx({ FOLLOWUP_DAYS: '3', BUSINESS_ADDRESS: 'Rizer Web, 1 Main St, Cheyenne, WY 82001' });
  await store.upsertLeads([
    makeLead({ phone: '+15125550911', business_name: 'Handled', email: 'a@a.test' }),
    makeLead({ phone: '+15125550912', business_name: 'Bad address', email: 'b@b.test' }),
  ]);
  const past = new Date(Date.now() - 60000).toISOString();
  const hot = new Date(Date.now() - 864e5).toISOString();
  await store.updateLead(1, { status: 'interested', hot_at: hot, handled_at: new Date(Date.now() - 3600e3).toISOString(), followup_due_at: past });
  await store.updateLead(2, { status: 'interested', followup_due_at: past });
  let tries = 0;
  ctx.sendEmail = async () => { tries++; throw new Error('mailbox does not exist'); };
  await sendDueFollowups(ctx);
  assert.equal(tries, 1, 'the handled lead is never emailed');
  assert.equal((await store.getLead(1)).followup_sent_at, 'skipped');
  assert.ok(Date.parse((await store.getLead(2)).followup_due_at) > Date.now() + 50 * 60 * 1000, 'tried again in an hour');
  for (let i = 0; i < 6; i++) {
    await store.updateLead(2, { followup_due_at: past }); // as if the wait had passed
    await sendDueFollowups(ctx);
  }
  assert.equal(tries, 5);
  assert.equal((await store.getLead(2)).followup_sent_at, 'failed');
});

test('hot leads are posted to the webhook, signed', async () => {
  const { ctx, store } = await makeCtx({ WEBHOOK_URL: 'https://hooks.example.com/abc', PUBLIC_URL: 'https://calls.example.com' });
  await store.upsertLeads([makeLead({ phone: '+15125550921', business_name: 'Hook Spa', email: 'h@h.test' })]);
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { posts.push({ url, opts }); return new Response('ok'); };
  try {
    await notifyOwner(ctx, await store.getLead(1), { reason: 'Interested', summary: 'Wants it.', collected: { next_step: 'Send price' } });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://hooks.example.com/abc');
  const body = JSON.parse(posts[0].opts.body);
  assert.equal(body.event, 'hot_lead');
  assert.equal(body.reason, 'Interested');
  assert.equal(body.lead.business_name, 'Hook Spa');
  assert.equal(body.lead.phone, '+15125550921');
  assert.equal(body.next_step, 'Send price');
  assert.equal(body.dashboard_url, 'https://calls.example.com/#lead-1');
  const secret = await webhookSecret(store);
  assert.equal(posts[0].opts.headers['X-AI-Caller-Signature'], `sha256=${await hmacHex(secret, posts[0].opts.body)}`);
  assert.equal(await webhookSecret(store), secret, 'the secret stays the same');
});

test('the morning summary goes once a day, after the chosen hour', async () => {
  const { ctx, store, sent } = await makeCtx({ SUMMARY_EMAIL: 'true', SUMMARY_HOUR: '8', ALERT_EMAIL: 'f@x.test', DEFAULT_TIMEZONE: 'America/New_York' });
  await store.upsertLeads([makeLead({ phone: '+15125550931', business_name: 'Morning Dental' })]);
  const callId = await store.insertCall(1);
  await store.updateCall(callId, { status: 'completed', talked: 1, cost_cents: 42, outcome: JSON.stringify({ outcome: 'interested' }) });
  await store.updateLead(1, { hot_at: new Date().toISOString(), hot_reason: 'Interested', last_summary: 'Liked it.' });
  const today = localDate('America/New_York');
  assert.equal(await sendMorningSummary(ctx, zonedDate(today, 7, 30, 'America/New_York')), false, 'too early');
  assert.equal(await sendMorningSummary(ctx, zonedDate(today, 8, 10, 'America/New_York')), true);
  assert.equal(await sendMorningSummary(ctx, zonedDate(today, 9, 0, 'America/New_York')), false, 'once a day');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'f@x.test');
  assert.equal(sent[0].subject, 'AI caller: 1 call, 1 needs you');
  assert.match(sent[0].text, /Calls: 1 \(1 talked/);
  assert.match(sent[0].text, /Interested: 1/);
  assert.match(sent[0].text, /Estimated spend: \$0\.42/);
  assert.match(sent[0].text, /- Morning Dental \(Interested\), \+15125550931\n  Liked it\./);
});
