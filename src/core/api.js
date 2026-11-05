// Framework-free HTTP handlers for the dashboard API and the agent's tools.
// req = { method, path, query: {}, body, headers: { cookie, 'x-tool-secret', 'x-requested-with' }, ip }
// returns { status, json, headers? } or, for files, { status, raw: { body, contentType, filename? } }
// ctx = { config, env, store, sendEmail, queue: { poke() } }
//   env: the raw environment variables (saved dashboard settings are layered on top of them in config)
import { rowsToLeads, normalizePhone } from './leads.js';
import { settingsForDashboard, cleanSettingsUpdate } from './settings.js';
import { placeCall, sendDemoLink, markDoNotCall, providerProblem, checkAvailability, bookMeeting } from './actions.js';
import { calcomReady, getSlots, spokenTime } from './calcom.js';
import { enqueueLeads, queueState, clearQueue } from './queue.js';
import { randomToken, secretEqual } from './crypto.js';
import { fetchRecording, setInboundUrl } from './twilio.js';

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
      if (path === '/tools/check-availability') return ok(await checkAvailability(ctx, pick(body, ['lead_id', 'day'])));
      if (path === '/tools/book-meeting') return ok(await bookMeeting(ctx, pick(body, ['lead_id', 'start', 'name', 'email'])));
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
        calcom: calcomReady(config.calcom),
      },
      calling: config.calling,
      queue: await queueState(ctx),
      webhookUrl: `${config.publicUrl}/webhooks/elevenlabs`,
      inboundUrl: `${config.publicUrl}/twilio/inbound`,
      toolUrls: {
        sendDemoLink: `${config.publicUrl}/tools/send-demo-link`,
        doNotCall: `${config.publicUrl}/tools/do-not-call`,
        checkAvailability: `${config.publicUrl}/tools/check-availability`,
        bookMeeting: `${config.publicUrl}/tools/book-meeting`,
      },
      counts: await store.statusCounts(),
      needsYou: await store.countNeedsYou(),
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

  // ---- Campaigns: a named call list that can be paused, resumed and stopped ----
  if (path === '/api/campaigns' && method === 'GET') return ok({ campaigns: await store.listCampaigns() });
  if (path === '/api/campaigns' && method === 'POST') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return ok({ error: 'Pick the businesses to call first' }, 400);
    const variant = ['A', 'B', 'AB'].includes(body.variant) ? body.variant : 'A';
    if (variant !== 'A' && !config.prompt.b) return ok({ error: 'Write script B in Settings → Script first' }, 400);
    const name = String(body.name || '').trim().slice(0, 100) || `Calls ${new Date().toISOString().slice(0, 10)}`;
    const campaignId = await store.createCampaign(name, variant);
    const results = await enqueueLeads(ctx, ids, { campaignId });
    await ctx.queue.poke();
    return ok({ campaignId, results });
  }
  if (method === 'POST' && (m = path.match(/^\/api\/campaigns\/(\d+)\/(pause|resume|stop)$/))) {
    const id = Number(m[1]);
    if (!(await store.getCampaign(id))) return ok({ error: 'not found' }, 404);
    if (m[2] === 'stop') await store.dequeueCampaign(id);
    await store.setCampaignStatus(id, { pause: 'paused', resume: 'running', stop: 'stopped' }[m[2]]);
    if (m[2] === 'resume') await ctx.queue.poke();
    return ok({ ok: true });
  }

  // ---- The sales script (OpenAI calls) ----
  if (path === '/api/script' && method === 'GET') {
    return ok({ default: ctx.defaultPrompt ?? '', a: config.prompt.a, b: config.prompt.b });
  }

  // ---- Results and export ----
  if (method === 'GET' && path === '/api/analytics') {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const [totals, campaigns, variants, categories, byDay] = await Promise.all([
      store.analytics(since), store.analytics(since, 'campaign'), store.analytics(since, 'variant'),
      store.analytics(since, 'category'), store.analytics(since, 'day'),
    ]);
    return ok({ days, totals: totals[0], campaigns, variants, categories, byDay });
  }
  if (method === 'GET' && path === '/api/export.csv') {
    const rows = await store.exportLeads();
    const cols = ['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category', 'city', 'status',
      'attempts', 'last_called_at', 'meeting_time', 'hot_reason', 'last_summary', 'next_step', 'requests', 'campaign', 'notes'];
    const cell = (v) => {
      let t = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // never let a cell run as a spreadsheet formula
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
    return { status: 200, raw: { body: csv, contentType: 'text/csv; charset=utf-8', filename: `businesses-${new Date().toISOString().slice(0, 10)}.csv` } };
  }
  if (method === 'POST' && path === '/api/leads/bulk') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!SETTABLE_STATUSES.includes(body.status)) return ok({ error: 'That status can’t be set by hand' }, 400);
    await store.bulkStatus(ids, body.status);
    return ok({ ok: true });
  }

  if (method === 'GET' && path === '/api/needs-you') return ok({ leads: await store.needsYou() });
  if (method === 'POST' && (m = path.match(/^\/api\/leads\/(\d+)\/handled$/))) {
    await store.updateLead(Number(m[1]), { handled_at: new Date().toISOString() });
    return ok({ ok: true });
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
      lead.next_call_at = await store.nextCallAt(id);
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

  if (method === 'GET' && (m = path.match(/^\/api\/calls\/(\d+)\/recording$/))) {
    const call = await store.getCall(m[1]);
    if (!call?.recording_sid) return ok({ error: 'no recording for this call' }, 404);
    return { status: 200, raw: { body: await fetchRecording(config.twilio, call.recording_sid), contentType: 'audio/mpeg' } };
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
  // Points the Twilio number's incoming calls at the AI, so callbacks are answered.
  if (method === 'POST' && path === '/api/setup/inbound') {
    const tw = config.twilio;
    if (!tw.accountSid || !tw.authToken || !tw.fromNumber) return ok({ error: 'Add your Twilio details first' }, 400);
    if (!/^https:\/\//.test(config.publicUrl)) return ok({ error: `Your address must start with https:// (it's ${config.publicUrl})` }, 400);
    try {
      await setInboundUrl(tw, `${config.publicUrl}/twilio/inbound`);
    } catch (err) {
      return ok({ error: err.message }, 400);
    }
    return ok({ ok: true, voiceUrl: `${config.publicUrl}/twilio/inbound` });
  }

  // Checks the Cal.com details by fetching real open times.
  if (method === 'POST' && path === '/api/setup/calcom') {
    if (!calcomReady(config.calcom)) return ok({ error: 'Add your Cal.com API key, username and event first, then save' }, 400);
    try {
      const tz = config.calling.defaultTimezone;
      const slots = await getSlots(config.calcom, { timeZone: tz, days: 7 });
      return ok({ ok: true, count: slots.length, next: slots[0] ? spokenTime(slots[0], tz) : null });
    } catch (err) {
      return ok({ error: `Cal.com said: ${err.message}` }, 400);
    }
  }

  if (method === 'POST' && path === '/api/queue/clear') {
    await clearQueue(ctx);
    return ok(await queueState(ctx));
  }
  return ok({ error: 'not found' }, 404);
}
