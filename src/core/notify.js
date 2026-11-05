// Tells the owner about hot leads (email + the dashboard's "Needs you" list + an optional webhook), sends
// the optional one-time follow-up email to businesses that got the preview, and the morning summary.
import { hmacHex, randomToken } from './crypto.js';
import { localDate, localTimeInfo, isValidTimezone } from './leads.js';

// Why a call needs the owner's attention, or null if it doesn't.
export function hotReason({ status, outcome, inbound, talked }) {
  if (outcome === 'transferred') return 'Talked to you on a live transfer';
  if (status === 'won') return 'Said yes';
  if (outcome === 'meeting_booked') return 'Booked a call with you';
  if (status === 'interested') return 'Interested';
  if (status === 'callback') return 'Wants a call back';
  if (inbound && talked) return 'Called you back';
  return null;
}

const addressOf = (from) => (String(from || '').match(/<([^>]+)>/)?.[1] ?? String(from || '').trim()) || null;

export async function notifyOwner(ctx, lead, { reason, summary, collected = {} }) {
  const { config, store } = ctx;
  await store.updateLead(lead.id, { hot_at: new Date().toISOString(), hot_reason: reason });
  await sendWebhook(ctx, lead, { reason, summary, collected });
  const to = config.alerts.email || addressOf(config.email.from);
  if (!ctx.sendEmail || !to) return;
  const lines = [
    `${reason}: ${lead.business_name}`,
    '',
    lead.contact_name ? `Contact: ${lead.contact_name}` : null,
    `Phone: ${lead.phone}`,
    lead.email || collected.email ? `Email: ${lead.email || collected.email}` : null,
    lead.meeting_time || collected.meeting_time ? `Follow up: ${collected.meeting_time || lead.meeting_time}` : null,
    '',
    summary ? `What happened: ${summary}` : null,
    collected.next_step ? `Next step: ${collected.next_step}` : null,
    collected.requests ? `They asked for: ${collected.requests}` : null,
    '',
    `Open it in the dashboard: ${config.publicUrl}/#lead-${lead.id}`,
  ].filter((l) => l !== null);
  try {
    await ctx.sendEmail(to, `${reason}: ${lead.business_name}`, lines.join('\n'));
    await store.logEvent(lead.id, 'owner_alerted', reason);
  } catch (err) {
    await store.logEvent(lead.id, 'alert_failed', err.message);
  }
}

// The secret that signs webhook posts, made on first use and kept in the database.
export async function webhookSecret(store) {
  let secret = await store.getMeta('webhook_secret');
  if (!secret) {
    await store.claimMeta('webhook_secret', randomToken(24));
    secret = await store.getMeta('webhook_secret');
  }
  return secret;
}

// Posts a hot lead to WEBHOOK_URL (e.g. a Zapier/Make hook that adds a row to Google Sheets).
// Header X-AI-Caller-Signature: sha256=<HMAC-SHA256 of the body with the webhook secret>.
export async function sendWebhook(ctx, lead, { reason, summary, collected = {} }) {
  const { config, store } = ctx;
  if (!config.alerts.webhookUrl) return;
  const body = JSON.stringify({
    event: 'hot_lead', reason, at: new Date().toISOString(),
    lead: {
      id: lead.id, business_name: lead.business_name, contact_name: lead.contact_name || collected.decision_maker_name || null,
      phone: String(lead.phone).startsWith('hidden:') ? null : lead.phone, email: lead.email || collected.email || null,
      website: lead.website, demo_link: lead.demo_link, category: lead.category, city: lead.city, status: lead.status,
      meeting_time: lead.meeting_time || collected.meeting_time || null,
    },
    summary: summary || null, next_step: collected.next_step || null, requests: collected.requests || null,
    dashboard_url: `${config.publicUrl}/#lead-${lead.id}`,
  });
  try {
    const res = await fetch(config.alerts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Caller-Signature': `sha256=${await hmacHex(await webhookSecret(store), body)}` },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await store.logEvent(lead.id, 'webhook_sent', reason);
  } catch (err) {
    await store.logEvent(lead.id, 'webhook_failed', err.message);
  }
}

// The morning email: once a day, at SUMMARY_HOUR in the default timezone, if anything happened.
export async function sendMorningSummary(ctx, now = new Date()) {
  const { config, store } = ctx;
  const a = config.alerts;
  const to = a.email || addressOf(config.email.from);
  if (!a.summaryEmail || !ctx.sendEmail || !to) return false;
  const tz = isValidTimezone(config.calling.defaultTimezone) ? config.calling.defaultTimezone : 'America/New_York';
  if (localTimeInfo(tz, now).hour < a.summaryHour) return false;
  const today = localDate(tz, now);
  if ((await store.getMeta('summary_sent')) === today) return false;
  const [day] = await store.analytics(new Date(now.getTime() - 864e5).toISOString());
  const hot = await store.needsYou();
  const queue = await store.queueStats();
  // Claimed before sending, so two servers (or two cron runs) never both send it.
  if (!(await store.claimMeta('summary_sent', today))) return false;
  if (!day?.calls && !hot.length && !queue.pending) return false; // a quiet day: no email
  const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const lines = [
    'Good morning! Here is what your AI caller did in the last 24 hours:',
    '',
    `Calls: ${day?.calls || 0} (${day?.talked || 0} talked, ${day?.voicemail || 0} voicemail, ${day?.inbound || 0} called you)`,
    `Interested: ${day?.interested || 0} · Booked a call: ${day?.booked || 0} · Said yes: ${day?.won || 0}`,
    `Estimated spend: ${money(day?.cost_cents)}`,
    '',
    hot.length ? `Needs you (${hot.length}):` : 'Nobody is waiting on you.',
    ...hot.slice(0, 15).map((l) => `- ${l.business_name} (${l.hot_reason})${String(l.phone).startsWith('hidden:') ? '' : `, ${l.phone}`}` +
      `${l.meeting_time ? `, follow up: ${l.meeting_time}` : ''}${l.last_summary ? `\n  ${l.last_summary}` : ''}`),
    hot.length > 15 ? `...and ${hot.length - 15} more.` : null,
    '',
    queue.pending ? `Waiting to be called: ${queue.pending}${config.calling.paused ? ' (calling is paused)' : ''}.` : 'Nobody is waiting to be called.',
    '',
    `Open the dashboard: ${config.publicUrl}/`,
  ].filter((l) => l !== null);
  try {
    const calls = day?.calls || 0;
    await ctx.sendEmail(to, `AI caller: ${calls} call${calls === 1 ? '' : 's'}, ${hot.length} need${hot.length === 1 ? 's' : ''} you`, lines.join('\n'));
  } catch (err) {
    await store.setMeta('summary_sent', ''); // try again on the next run
    await store.logEvent(null, 'summary_failed', err.message);
    return false;
  }
  return true;
}

// Regular upkeep, every few minutes (Node timer / Cloudflare cron): stuck calls, old sessions, follow-ups,
// the morning summary.
export async function housekeeping(ctx) {
  const { store, config } = ctx;
  const callWindow = (config.calling.maxCallSeconds + 10 * 60) * 1000;
  await store.releaseStuckCalls(new Date(Date.now() - callWindow).toISOString(), new Date(Date.now() - (4 * 3600 + 600) * 1000).toISOString());
  await store.purgeAuth();
  await sendDueFollowups(ctx);
  await sendMorningSummary(ctx);
}

// After a preview email, schedule the single follow-up (if turned on).
export async function scheduleFollowup(ctx, lead) {
  const days = ctx.config.alerts.followupDays;
  if (days > 0 && !lead.followup_due_at && !lead.followup_sent_at) {
    await ctx.store.updateLead(lead.id, { followup_due_at: new Date(Date.now() + days * 864e5).toISOString() });
  }
}

// Sends follow-ups that are due. Skips anyone who said yes or no, asked not to be contacted, or that the
// owner already dealt with. Runs from the housekeeping timer (Node) or the cron (Cloudflare).
export async function sendDueFollowups(ctx) {
  const { config, store } = ctx;
  if (!ctx.sendEmail || !(config.alerts.followupDays > 0)) return 0;
  const s = config.seller;
  let sent = 0;
  for (const lead of await store.dueFollowups(new Date().toISOString())) {
    const done = ['won', 'dnc', 'not_interested'].includes(lead.status) || (lead.handled_at && lead.hot_at && lead.handled_at >= lead.hot_at);
    if (done || !lead.email || !lead.demo_link) {
      await store.updateLead(lead.id, { followup_sent_at: 'skipped' });
      continue;
    }
    const text = [
      lead.contact_name ? `Hi ${lead.contact_name},` : 'Hi,',
      '',
      `Just following up on the new website we made for ${lead.business_name}:`,
      lead.demo_link,
      '',
      'Happy to change anything you\'d like. If you want to go ahead, just reply to this email.',
      '',
      s.yourName || '',
      s.company || '',
      '',
      '--',
      config.alerts.businessAddress,
      'If you\'d rather not hear from us again, reply "stop".',
    ].join('\n');
    try {
      await ctx.sendEmail(lead.email, `Following up: new website for ${lead.business_name}`, text);
      await store.updateLead(lead.id, { followup_sent_at: new Date().toISOString() });
      await store.logEvent(lead.id, 'followup_sent', lead.email);
      sent++;
    } catch (err) {
      await store.logEvent(lead.id, 'followup_failed', err.message);
      // Try again later, waiting longer each time (an email outage passes); give up after 5 tries so one
      // bad address can't hold up everyone else's follow-up.
      const tries = await store.countEvents(lead.id, 'followup_failed');
      await store.updateLead(lead.id, tries >= 5
        ? { followup_sent_at: 'failed' }
        : { followup_due_at: new Date(Date.now() + tries * 3600 * 1000).toISOString() });
    }
  }
  return sent;
}
