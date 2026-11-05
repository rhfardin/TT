// The call queue lives in the database (queue_items), so it survives restarts and both platforms share
// it: a timer runs runDue() on Node, a Durable Object alarm runs it on Cloudflare. One call at a time.
import { checkLead, nextWindowStart } from './leads.js';
import { placeCall, providerProblem } from './actions.js';

const MAX_ITEMS_PER_RUN = 4; // keeps one run inside Cloudflare's 50-queries-per-request limit (Free plan)

// How long a call can possibly be going on (the AI's time limit plus a margin).
export const callWindowMs = (config) => (config.calling.maxCallSeconds + 10 * 60) * 1000;

export async function enqueueLeads(ctx, idList, { ignoreWindow = false, now = new Date(), campaignId = null } = {}) {
  const { store, config } = ctx;
  const unique = [...new Set(idList.map(Number).filter(Number.isFinite))].slice(0, 5000);
  await store.dropStoppedQueueItems(unique); // left over from a stopped campaign: free to queue again
  const leads = new Map((await store.getLeadsByIds(unique)).map((l) => [l.id, l]));
  const waiting = new Set(await store.queuedLeadIds(unique));
  const blocked = new Set(await store.dncLeadIds(unique));
  const results = [];
  const accepted = [];
  for (const id of unique) {
    const check = checkLead(leads.get(id), config.calling, { ignoreWindow: true });
    if (!check.ok) results.push({ id, queued: false, reason: check.reason });
    else if (blocked.has(id)) results.push({ id, queued: false, reason: 'on your do-not-call list' });
    else if (waiting.has(id)) results.push({ id, queued: false, reason: 'already waiting to be called' });
    else {
      accepted.push(id);
      results.push({ id, queued: true });
    }
  }
  if (accepted.length) {
    await store.enqueueMany(accepted, now.toISOString(), ignoreWindow, campaignId ? 'campaign' : 'manual', campaignId);
    await store.setLeadsCampaign(accepted, campaignId); // a manual batch belongs to no campaign
  }
  return results;
}

// Places the next due call, if any. Returns how long to wait before running again (null = nothing queued).
export async function runDue(ctx, now = new Date()) {
  const { store, config } = ctx;
  await store.releaseStaleClaims(new Date(now.getTime() - 10 * 60 * 1000).toISOString());
  if (providerProblem(config)) {
    // Keep the queue until the keys or address are fixed; nothing to wake up for if it's empty.
    return { placed: false, waitMs: (await store.queueStats()).pending ? 60 * 1000 : null };
  }
  if ((await store.activeCallCount(callWindowMs(config))) > 0) return { placed: false, waitMs: 20 * 1000 };
  const gate = await callGate(ctx, now);
  if (gate) return { placed: false, waitMs: gate };

  for (let i = 0; i < MAX_ITEMS_PER_RUN; i++) {
    const item = await store.nextDueItem(now.toISOString());
    if (!item) break;
    if (!(await store.claimQueueItem(item.id))) continue;
    const lead = await store.getLead(item.lead_id);
    if (lead?.status === 'calling') {
      // Still on an earlier call: try again shortly instead of dropping them.
      await store.rescheduleQueueItem(item.id, new Date(now.getTime() + 2 * 60 * 1000).toISOString());
      continue;
    }
    // They asked us to call back at this time: the max-tries limit doesn't apply, and neither do the calling
    // hours, but only close to that time. Much later (calling was paused, the server was down) it waits
    // for the normal hours instead of ringing them at night.
    const callback = item.reason === 'callback requested';
    const onTime = now.getTime() - Date.parse(item.not_before) <= 30 * 60 * 1000;
    const check = checkLead(lead && callback ? { ...lead, attempts: 0 } : lead, config.calling, { ignoreWindow: Boolean(item.ignore_window) && onTime, now });
    if (!check.ok) {
      if (lead && checkLead(lead, config.calling, { ignoreWindow: true }).ok) {
        // Only the hours are wrong: wait for the business's next calling window.
        await store.rescheduleQueueItem(item.id, nextWindowStart(lead, config.calling, now).toISOString());
      } else {
        await store.deleteQueueItem(item.id);
        await store.logEvent(item.lead_id, 'queue_skip', check.reason);
      }
      continue;
    }
    const r = await placeCall(ctx, lead.id, { ignoreWindow: true, campaignId: item.campaign_id, resetTries: callback });
    if (r.limited) {
      // A limit was reached meanwhile: keep their place in the queue and wait.
      await store.rescheduleQueueItem(item.id, now.toISOString());
      return { placed: false, waitMs: (await callGate(ctx, now)) ?? 60 * 1000 };
    }
    if (r.retryAfterMs) {
      // Not this business's fault (an outage, or they're on the phone with us): keep their place.
      await store.rescheduleQueueItem(item.id, new Date(now.getTime() + r.retryAfterMs).toISOString());
      await store.logEvent(lead.id, 'queue_wait', r.error);
      if (r.outage) return { placed: false, waitMs: 5 * 60 * 1000 }; // everyone else would fail too
      continue;
    }
    await store.deleteQueueItem(item.id);
    if (!r.ok) {
      await store.logEvent(lead.id, 'queue_skip', r.error);
      break; // one failed call per run, so a Twilio problem can't burn through the whole list at once
    }
    return { placed: true, waitMs: config.calling.spacingSeconds * 1000 };
  }

  const { nextAt } = await store.queueStats();
  if (!nextAt) return { placed: false, waitMs: null };
  return { placed: false, waitMs: Math.max(1000, Date.parse(nextAt) - now.getTime()) };
}

// Reasons the next call has to wait, whatever is queued: the gap between calls and the daily limit.
// Returns milliseconds to wait, or null if a call may go out now.
export async function callGate(ctx, now = new Date()) {
  const { store, config } = ctx;
  if (config.calling.paused) return 5 * 60 * 1000; // checked again now and then; Resume wakes the queue at once
  let wait = 0;
  const limit = config.calling.dailySpendLimitCents;
  if (limit && (await store.spendLast24h()) >= limit) wait = 15 * 60 * 1000; // spend drops as older calls age out
  const day = await store.callsLast24h();
  if (day.count >= config.calling.maxCallsPerDay && day.oldest) {
    // Wait until the oldest call of the last 24 hours drops out of the count.
    const frees = Date.parse(`${day.oldest.replace(' ', 'T')}Z`) + 864e5;
    wait = Math.max(60 * 1000, frees - now.getTime());
  }
  const last = await store.lastOutboundCallAt();
  if (last) {
    const since = now.getTime() - Date.parse(`${last.replace(' ', 'T')}Z`);
    wait = Math.max(wait, config.calling.spacingSeconds * 1000 - since);
  }
  return wait > 0 ? wait : null;
}

export async function queueState(ctx) {
  const stats = await ctx.store.queueStats();
  return { ...stats, active: await ctx.store.activeCallCount(callWindowMs(ctx.config)) };
}

export async function clearQueue(ctx) {
  await ctx.store.clearQueue();
  await ctx.store.stopAllCampaigns();
}
