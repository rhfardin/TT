// Framework-free HTTP handlers for the dashboard API and the agent's tools.
// req = { method, path, query: {}, body, headers: { cookie, 'x-tool-secret' } }
// returns { status, json, headers? }
// ctx = { config, env, store, sendEmail, queue: { enqueue(ids, opts), state(), clear() } }
//   env: the raw environment variables (saved dashboard settings are layered on top of them in config)
import { rowsToLeads, canCallNow, normalizePhone } from './leads.js';
import { settingsForDashboard, cleanSettingsUpdate } from './settings.js';
import { placeCall, sendDemoLink, markDoNotCall, providerProblem } from './actions.js';
import { hmacHex, safeEqual } from './crypto.js';

const ok = (json, status = 200, headers) => ({ status, json, headers });
const EDITABLE = ['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category', 'city',
  'timezone', 'notes', 'status', 'attempts', 'meeting_time'];

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const sessionToken = (config) => hmacHex(config.adminPassword, 'dashboard-session');

export async function handleRequest(ctx, req) {
  const { config, store } = ctx;
  const { method, path } = req;
  const body = req.body || {};

  // Tools the AI agent calls mid-conversation (ElevenLabs webhook tools).
  if (path.startsWith('/tools/')) {
    if (!config.toolSecret || !safeEqual(req.headers['x-tool-secret'], config.toolSecret)) {
      return ok({ ok: false, message: 'unauthorized' }, 401);
    }
    try {
      if (path === '/tools/send-demo-link') return ok(await sendDemoLink(ctx, body));
      if (path === '/tools/do-not-call') return ok(await markDoNotCall(ctx, body));
    } catch (err) {
      return ok({ ok: false, message: 'That did not work. Tell them the team will follow up shortly.' });
    }
    return ok({ error: 'not found' }, 404);
  }

  const secure = config.publicUrl.startsWith('https') ? '; Secure' : '';
  if (method === 'POST' && path === '/api/login') {
    if (!config.adminPassword || !safeEqual(body.password, config.adminPassword)) return ok({ error: 'Wrong password' }, 401);
    return ok({ ok: true }, 200, {
      'Set-Cookie': `session=${await sessionToken(config)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`,
    });
  }
  if (method === 'POST' && path === '/api/logout') {
    return ok({ ok: true }, 200, { 'Set-Cookie': `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
  }
  if (!config.adminPassword || !safeEqual(parseCookies(req.headers.cookie).session, await sessionToken(config))) {
    return ok({ error: 'login required' }, 401);
  }

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
      queue: await ctx.queue.state(),
      webhookUrl: `${config.publicUrl}/webhooks/elevenlabs`,
      toolUrls: {
        sendDemoLink: `${config.publicUrl}/tools/send-demo-link`,
        doNotCall: `${config.publicUrl}/tools/do-not-call`,
      },
      counts: await store.statusCounts(),
    });
  }

  if (path === '/api/settings') {
    if (method === 'GET') return ok(settingsForDashboard(ctx.env, await store.getSettings()));
    if (method === 'PUT') {
      await store.saveSettings(cleanSettingsUpdate(body));
      return ok({ ok: true });
    }
  }

  // Calls your own phone with a pretend business, ignoring calling hours and attempt limits.
  if (method === 'POST' && path === '/api/test-call') {
    const phone = normalizePhone(body.phone, config.calling.defaultCountryCode);
    if (!phone) return ok({ ok: false, error: 'Enter a valid phone number' }, 400);
    await store.upsertLeads([{
      phone, business_name: body.business_name || 'Test Business', contact_name: body.contact_name || null,
      email: body.email || null, website: null, demo_link: body.demo_link || null, category: body.category || 'dental',
      city: null, timezone: null, notes: 'This is a test call to the owner of the calling system.', extra: '{}',
    }]);
    const lead = await store.getLeadByPhone(phone);
    await store.updateLead(lead.id, { status: 'new', attempts: 0 });
    const r = await placeCall(ctx, lead.id, { ignoreWindow: true });
    return ok({ ...r, leadId: lead.id }, r.ok ? 200 : 400);
  }

  if (method === 'POST' && path === '/api/import') {
    try {
      const { leads, skipped, mapping } = rowsToLeads(body.rows, config.calling.defaultCountryCode);
      await store.upsertLeads(leads);
      await store.logEvent(null, 'import', { filename: body.filename, imported: leads.length, skipped: skipped.length });
      return ok({ imported: leads.length, skipped, mapping });
    } catch (err) {
      return ok({ error: err.message }, 400);
    }
  }

  if (method === 'GET' && path === '/api/leads') {
    const leads = await store.listLeads(req.query);
    for (const l of leads) l.callable_now = canCallNow(l, config.calling);
    return ok({ leads, categories: await store.categories() });
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
      await store.updateLead(id, Object.fromEntries(Object.entries(body).filter(([k]) => EDITABLE.includes(k))));
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
    const ids = Array.isArray(body.ids) ? body.ids : [];
    return ok({ results: await ctx.queue.enqueue(ids, { ignoreWindow: Boolean(body.ignoreWindow) }) });
  }
  if (method === 'POST' && path === '/api/queue/clear') {
    await ctx.queue.clear();
    return ok(await ctx.queue.state());
  }
  return ok({ error: 'not found' }, 404);
}
