import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, getLead, updateLead, logEvent } from './db.js';
import { importSpreadsheet } from './importer.js';
import { placeCall, enqueue, queueState, clearQueue, canCallNow } from './caller.js';
import { verifySignature, handlePostCall } from './webhooks.js';
import { sendDemoLink, markDoNotCall } from './tools.js';
import { attachOpenAIBridge } from './openai-bridge.js';
import { validTwilioSignature } from './twilio.js';
import { recordNotConnected } from './results.js';

if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD must be set.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Webhooks from ElevenLabs (raw body needed for the signature) ----
app.post('/webhooks/elevenlabs', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifySignature(raw, req.get('elevenlabs-signature'))) return res.status(401).send('bad signature');
  try {
    handlePostCall(JSON.parse(raw));
  } catch (err) {
    console.error('webhook error', err);
    logEvent(null, 'webhook_error', String(err));
  }
  res.sendStatus(200);
});

// ---- Twilio call status (OpenAI provider): catches calls that never connected ----
app.post('/twilio/status', express.urlencoded({ extended: false }), (req, res) => {
  const url = `${config.publicUrl}${req.originalUrl}`;
  if (!validTwilioSignature(url, req.body, req.get('x-twilio-signature'))) return res.status(403).send('bad signature');
  const callId = Number(req.query.call);
  const status = req.body.CallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) recordNotConnected(callId, status);
  res.type('text/xml').send('<Response/>');
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---- Server tools the AI agent calls mid-conversation ----
function toolAuth(req, res, next) {
  const given = req.get('x-tool-secret') || '';
  const ok = config.toolSecret && given.length === config.toolSecret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.toolSecret));
  if (!ok) return res.status(401).json({ ok: false, message: 'unauthorized' });
  next();
}
app.post('/tools/send-demo-link', toolAuth, async (req, res) => {
  try {
    res.json(await sendDemoLink(req.body || {}));
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Sending failed. Tell them the team will email it over shortly.' });
  }
});
app.post('/tools/do-not-call', toolAuth, (req, res) => res.json(markDoNotCall(req.body || {})));

// ---- Dashboard auth ----
const sessionToken = crypto.createHmac('sha256', config.adminPassword).update('dashboard-session').digest('hex');
app.post('/api/login', (req, res) => {
  const pw = String(req.body?.password ?? '');
  const ok = pw.length === config.adminPassword.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(config.adminPassword));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('session', sessionToken, {
    httpOnly: true, sameSite: 'strict', secure: config.publicUrl.startsWith('https'), maxAge: 30 * 864e5,
  });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.use('/api', (req, res, next) => {
  if (req.cookies.session !== sessionToken) return res.status(401).json({ error: 'login required' });
  next();
});

// ---- Dashboard API ----
app.get('/api/status', (req, res) => {
  const el = config.elevenlabs;
  res.json({
    provider: config.voiceProvider,
    configured: {
      openai: Boolean(config.openai.apiKey && config.twilio.accountSid && config.twilio.fromNumber),
      elevenlabs: Boolean(el.apiKey && el.agentId && el.phoneNumberId),
      webhookSecret: Boolean(el.webhookSecret),
      toolSecret: Boolean(config.toolSecret),
      email: Boolean(config.smtp.host),
      sms: Boolean(config.twilio.accountSid && config.twilio.fromNumber),
    },
    calling: config.calling,
    queue: queueState(),
    webhookUrl: `${config.publicUrl}/webhooks/elevenlabs`,
    toolUrls: {
      sendDemoLink: `${config.publicUrl}/tools/send-demo-link`,
      doNotCall: `${config.publicUrl}/tools/do-not-call`,
    },
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all(),
  });
});

app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(await importSpreadsheet(req.file.buffer, req.file.originalname));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/leads', (req, res) => {
  const { status, q, category } = req.query;
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (category) { where.push('category = ?'); args.push(category); }
  if (q) {
    where.push('(business_name LIKE ? OR contact_name LIKE ? OR phone LIKE ? OR city LIKE ?)');
    args.push(...Array(4).fill(`%${q}%`));
  }
  const leads = db.prepare(`SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                            ORDER BY id DESC LIMIT 2000`).all(...args);
  for (const l of leads) l.callable_now = canCallNow(l);
  const categories = db.prepare('SELECT DISTINCT category FROM leads WHERE category IS NOT NULL ORDER BY category').all()
    .map((r) => r.category);
  res.json({ leads, categories });
});

app.get('/api/leads/:id', (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const calls = db.prepare('SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC').all(lead.id)
    .map((c) => ({ ...c, transcript: JSON.parse(c.transcript || '[]'), outcome: JSON.parse(c.outcome || 'null') }));
  const events = db.prepare('SELECT * FROM events WHERE lead_id = ? ORDER BY id DESC LIMIT 50').all(lead.id);
  res.json({ lead, calls, events });
});

const EDITABLE = ['business_name', 'contact_name', 'phone', 'email', 'website', 'demo_link', 'category', 'city',
  'timezone', 'notes', 'status', 'attempts', 'meeting_time'];
app.patch('/api/leads/:id', (req, res) => {
  const fields = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => EDITABLE.includes(k)));
  updateLead(req.params.id, fields);
  res.json(getLead(req.params.id));
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE lead_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM calls WHERE lead_id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM leads WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Call one lead right now.
app.post('/api/leads/:id/call', async (req, res) => {
  const r = await placeCall(req.params.id, { ignoreWindow: Boolean(req.body?.ignoreWindow) });
  res.status(r.ok ? 200 : 400).json(r);
});

// Queue several leads; they are called one after another.
app.post('/api/call-batch', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  res.json({ results: enqueue(ids, { ignoreWindow: Boolean(req.body?.ignoreWindow) }) });
});
app.post('/api/queue/clear', (req, res) => { clearQueue(); res.json(queueState()); });

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(root, 'public')));

const server = app.listen(config.port, () => {
  console.log(`AI caller running on port ${config.port} (public URL ${config.publicUrl}, voice: ${config.voiceProvider})`);
});
attachOpenAIBridge(server);
