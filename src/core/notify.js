// Tells the owner about hot leads (email + the dashboard's "Needs you" list) and sends the optional
// one-time follow-up email to businesses that got the preview.

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
    const done = ['won', 'dnc', 'not_interested'].includes(lead.status) || (lead.handled_at && lead.handled_at > lead.followup_due_at);
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
    }
  }
  return sent;
}
