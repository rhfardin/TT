// Framework-free HTTP handlers for the dashboard API and the agent's tools.
// req = { method, path, query: {}, body, headers: { cookie, 'x-tool-secret', 'x-requested-with' }, ip }
// returns { status, json, headers? }
// ctx = { config, env, store, sendEmail, queue: { poke() } }
//   env: the raw environment variables (saved dashboard settings are layered on top of them in config)
import { rowsToLeads, normalizePhone } from './leads.js';
import { settingsForDashboard, cleanSettingsUpdate } from './settings.js';
import { placeCall, sendDemoLink, markDoNotCall, providerProblem } from './actions.js';
import { enqueueLeads, queueState, clearQueue } from './queue.js';
import { randomToken, secretEqual } from './crypto.js';

const ok = (json, status = 200, headers) => ({ status, json, headers });
const EDITABLE = ['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category', 'city',
  'timezone', 'notes', 'status', 'attempts', 'meeting_time'];
// Statuses the owner can set by hand ("calling" is only ever set by the system).
const SETTABLE_STATUSES = ['new', 'no_answer', 'voicemail', 'callback', 'interested', 'won', 'completed', 'not_interested', 'failed', 'dnc'];
const SESSION_DAYS = 30;
const LOGIN_LIMIT = { tries: 5, minutes: 10 };

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

export async function handleRequest(ctx, req) {
  const { config, store } = ctx;
  const { method, path } = req;
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Tools the AI agent calls mid-conversation (ElevenLabs webhook tools).
  if (path.startsWith('/tools/')) {
    if (!(await secretEqual(req.headers['x-tool-secret'], config.toolSecret))) {
      return ok({ ok: false, message: 'unauthorized' }, 401);
    }
    try {
      if (path === '/tools/send-demo-link') return ok(await sendDemoLink(ctx, pick(body, ['lead_id', 'email', 'contact_name', 'channel'])));
      if (path === '/tools/do-not-call') return ok(await markDoNotCall(ctx, pick(body, ['lead_id', 'reason'])));
    } catch (err) {
      return ok({ ok: false, message: 'That did not work. Tell them the team will follow up shortly.' });
    }
    return ok({ error: 'not found' }, 404);
  }

  // Every change must come from the dashboard's own scripts (blocks cross-site form posts).
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') return ok({ error: 'bad request' }, 403);

  const secure = config.publicUrl.startsWith('https') ? '; Secure' : '';
  const sessionId = parseCookies(req.headers.cookie).session;
  if (method === 'POST' && path === '/api/login') {
    const key = `login:${req.ip || 'unknown'}`;
    const since = new Date(Date.now() - LOGIN_LIMIT.minutes * 60 * 1000).toISOString();
    if ((await store.recentLoginFailures(key, since)) >= LOGIN_LIMIT.tries) {
      return ok({ error: `Too many wrong passwords. Try again in ${LOGIN_LIMIT.minutes} minutes.` }, 429);
    }
    if (!(await secretEqual(body.password, config.adminPassword))) {
      await store.addLoginFailure(key);
      return ok({ error: 'Wrong password' }, 401);
    }
    await store.clearLoginFailures(key);
    const id = randomToken();
    await store.createSession(id, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
    return ok({ ok: true }, 200, {
      'Set-Cookie': `session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`,
    });
  }
  if (method === 'POST' && path === '/api/logout') {
    if (sessionId) await store.deleteSession(sessionId);
    return ok({ ok: true }, 200, { 'Set-Cookie': `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
  }
  if (!(await store.sessionValid(sessionId))) return ok({ error: 'login required' }, 401);

  let m;
  if (method === 'GET' && path === '/api/status') {
    return ok({
      provider: config.voiceProvider,
      providerProblem: providerProblem(config),
      configured: {
        openai: Boolean(config.openai.apiKey && config.twilio.accountSid && config.twilio.fromNumber),
        elevenlabs: Boolean(config.elevenlabs.apiKey && config.elevenlabs.agentId && config.elevenlabs.phoneNumberId),
        webhookSecret: Boolean(config.elevenlabs.webhookSecret),
        toolSecret: Boolean(config.toolSecret),
        email: Boolean(ctx.sendEmail),
        sms: Boolean(config.twilio.accountSid && config.twilio.fromNumber),
      },
      calling: config.calling,
      queue: await queueState(ctx),
      webhookUrl: `${config.publicUrl}/webhooks/elevenlabs`,
      toolUrls: {
        sendDemoLink: `${config.publicUrl}/tools/send-demo-link`,
        doNotCall: `${config.publicUrl}/tools/do-not-call`,
      },
      counts: await store.statusCounts(),
    });
  }

  if (path === '/api/settings') {
    const saved = await store.getSettings();
    if (method === 'GET') return ok(settingsForDashboard(ctx.env, saved));
    if (method === 'PUT') {
      const { values, errors } = cleanSettingsUpdate(body, { ...ctx.env, ...saved });
      if (errors.length) return ok({ error: errors.join('. ') }, 400);
      await store.saveSettings(values);
      return ok({ ok: true });
    }
  }

  // Calls your own phone with a pretend business, ignoring calling hours and attempt limits.
  if (method === 'POST' && path === '/api/test-call') {
    const phone = normalizePhone(body.phone, config.calling.defaultCountryCode);
    if (!phone) return ok({ ok: false, error: 'Enter a valid phone number' }, 400);
    const existing = await store.getLeadByPhone(phone);
    if (existing && !existing.is_test) {
      return ok({ ok: false, error: `That number belongs to ${existing.business_name} in your list. Use your own number.` }, 400);
    }
    await store.upsertLeads([{
      phone, business_name: String(body.business_name || 'Test Business').slice(0, 200), contact_name: null,
      email: null, website: null, demo_link: body.demo_link || 'https://example.com/preview', category: 'dental',
      city: null, timezone: null, notes: 'This is a test call to the owner of the calling system.', extra: '{}',
    }]);
    const lead = await store.getLeadByPhone(phone);
    await store.updateLead(lead.id, { is_test: 1, status: 'new', attempts: 0 });
    const r = await placeCall(ctx, lead.id, { ignoreWindow: true });
    return ok({ ...r, leadId: lead.id }, r.ok ? 200 : 400);
  }

  if (method === 'POST' && path === '/api/import') {
    try {
      const { leads, skipped, duplicates, mapping } = rowsToLeads(body.rows, config.calling.defaultCountryCode);
      await store.upsertLeads(leads);
      await store.logEvent(null, 'import', { filename: body.filename, imported: leads.length, skipped: skipped.length });
      return ok({ imported: leads.length, skipped, duplicates, mapping });
    } catch (err) {
      return ok({ error: err.message }, 400);
    }
  }

  if (method === 'GET' && path === '/api/leads') {
    const [leads, total] = await Promise.all([store.listLeads(req.query), store.countLeads(req.query)]);
    return ok({ leads, total });
  }

  if ((m = path.match(/^\/api\/leads\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const lead = await store.getLead(id);
      if (!lead) return ok({ error: 'not found' }, 404);
      const calls = (await store.callsForLead(id))
        .map((c) => ({ ...c, transcript: JSON.parse(c.transcript || '[]'), outcome: JSON.parse(c.outcome || 'null') }));
      return ok({ lead, calls, events: await store.eventsForLead(id) });
    }
    if (method === 'PATCH') {
      const fields = Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k)));
      if ('status' in fields && !SETTABLE_STATUSES.includes(fields.status)) return ok({ error: 'That status can’t be set by hand' }, 400);
      if ('attempts' in fields) {
        fields.attempts = Number(fields.attempts);
        if (!Number.isInteger(fields.attempts) || fields.attempts < 0 || fields.attempts > 100) return ok({ error: 'bad attempts' }, 400);
      }
      if ('phone' in fields) {
        fields.phone = normalizePhone(fields.phone, config.calling.defaultCountryCode);
        if (!fields.phone) return ok({ error: 'Enter a valid phone number' }, 400);
      }
      for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') fields[k] = v.slice(0, 5000);
      await store.updateLead(id, fields);
      return ok(await store.getLead(id));
    }
    if (method === 'DELETE') {
      await store.deleteLead(id);
      return ok({ ok: true });
    }
  }

  if (method === 'POST' && (m = path.match(/^\/api\/leads\/(\d+)\/call$/))) {
    const r = await placeCall(ctx, Number(m[1]), { ignoreWindow: Boolean(body.ignoreWindow) });
    return ok(r, r.ok ? 200 : 400);
  }
  if (method === 'POST' && path === '/api/call-batch') {
    const results = await enqueueLeads(ctx, Array.isArray(body.ids) ? body.ids : [], { ignoreWindow: Boolean(body.ignoreWindow) });
    await ctx.queue.poke();
    return ok({ results });
  }
  if (method === 'POST' && path === '/api/queue/clear') {
    await clearQueue(ctx);
    return ok(await queueState(ctx));
  }
  return ok({ error: 'not found' }, 404);
}
