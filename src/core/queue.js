// Batch calling helpers. The queue itself lives in memory on Node and in a Durable Object on Cloudflare;
// both call these so the rules are the same.
import { checkLead } from './leads.js';
import { placeCall } from './actions.js';

export async function prepareBatch(ctx, ids, opts, pendingIds) {
  const results = [];
  const accepted = [];
  for (const raw of ids) {
    const id = Number(raw);
    const check = checkLead(await ctx.store.getLead(id), ctx.config.calling, { ignoreWindow: true });
    if (!check.ok) { results.push({ id, queued: false, reason: check.reason }); continue; }
    if (pendingIds.includes(id) || accepted.some((a) => a.id === id)) {
      results.push({ id, queued: false, reason: 'already queued' });
      continue;
    }
    await ctx.store.updateLead(id, { status: 'queued' });
    accepted.push({ id, opts });
    results.push({ id, queued: true });
  }
  return { results, accepted };
}

// Returns true if a call was actually placed (so the caller should wait before the next one).
export async function runQueued(ctx, { id, opts }) {
  const lead = await ctx.store.getLead(id);
  if (lead?.status === 'queued') await ctx.store.updateLead(id, { status: lead.attempts ? 'no_answer' : 'new' });
  const r = await placeCall(ctx, id, opts);
  if (!r.ok) await ctx.store.logEvent(id, 'queue_skip', r.error);
  return r.ok;
}

export async function releaseQueued(ctx, items) {
  for (const { id } of items) {
    const lead = await ctx.store.getLead(id);
    if (lead?.status === 'queued') await ctx.store.updateLead(id, { status: lead.attempts ? 'no_answer' : 'new' });
  }
}
