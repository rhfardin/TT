// The call queue lives in the database (queue_items), so it survives restarts and both platforms share
// it: a timer runs runDue() on Node, a Durable Object alarm runs it on Cloudflare. One call at a time.
import { checkLead, nextWindowStart } from './leads.js';
import { placeCall, providerProblem } from './actions.js';

const MAX_ITEMS_PER_RUN = 6; // keeps one run well inside Cloudflare's per-request query limit

export async function enqueueLeads(ctx, idList, { ignoreWindow = false, now = new Date(), campaignId = null } = {}) {
  const { store, config } = ctx;
  const unique = [...new Set(idList.map(Number).filter(Number.isFinite))].slice(0, 5000);
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
    if (campaignId) await store.setLeadsCampaign(accepted, campaignId);
    else await store.markInCampaign(accepted);
  }
  return results;
}

// Places the next due call, if any. Returns how long to wait before running again (null = nothing queued).
export async function runDue(ctx, now = new Date()) {
  const { store, config } = ctx;
  await store.releaseStaleClaims(new Date(now.getTime() - 10 * 60 * 1000).toISOString());
  if (providerProblem(config)) return { placed: false, waitMs: 60 * 1000 }; // keep the queue until keys are added
  if ((await store.activeCallCount()) > 0) return { placed: false, waitMs: 20 * 1000 };
  // Daily limit reached: wait until the oldest call of the last 24 hours drops out of the count.
  const day = await store.callsLast24h();
  if (day.count >= config.calling.maxCallsPerDay) {
    const frees = Date.parse(`${day.oldest.replace(' ', 'T')}Z`) + 864e5;
    return { placed: false, waitMs: Math.max(60 * 1000, frees - now.getTime()) };
  }

  for (let i = 0; i < MAX_ITEMS_PER_RUN; i++) {
    const item = await store.nextDueItem(now.toISOString());
    if (!item) break;
    if (!(await store.claimQueueItem(item.id))) continue;
    const lead = await store.getLead(item.lead_id);
    const check = checkLead(lead, config.calling, { ignoreWindow: Boolean(item.ignore_window), now });
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
    const r = await placeCall(ctx, lead.id, { ignoreWindow: true, campaignId: item.campaign_id });
    await store.deleteQueueItem(item.id);
    if (!r.ok) {
      await store.logEvent(lead.id, 'queue_skip', r.error);
      continue;
    }
    return { placed: true, waitMs: config.calling.spacingSeconds * 1000 };
  }

  const { nextAt } = await store.queueStats();
  if (!nextAt) return { placed: false, waitMs: null };
  return { placed: false, waitMs: Math.max(1000, Date.parse(nextAt) - now.getTime()) };
}

export async function queueState(ctx) {
  const stats = await ctx.store.queueStats();
  return { ...stats, active: await ctx.store.activeCallCount() };
}

export async function clearQueue(ctx) {
  await ctx.store.clearQueue();
  await ctx.store.stopAllCampaigns();
}
