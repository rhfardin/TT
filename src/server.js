// Node.js server (VPS / Docker / your own computer). The Cloudflare version lives in worker/.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { WebSocketServer, WebSocket } from 'ws';
import { buildConfig } from './core/config.js';
import { SCHEMA } from './core/schema.js';
import { createStore } from './core/store.js';
import { handleRequest } from './core/api.js';
import { prepareBatch, runQueued, releaseQueued } from './core/queue.js';
import { recordNotConnected, verifyElevenLabsSignature, handleElevenLabsWebhook } from './core/actions.js';
import { validTwilioSignature } from './core/twilio.js';
import { resendSender, textToHtml } from './core/email.js';
import { CallBridge } from './core/bridge.js';

const config = buildConfig(process.env);
if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD must be set.');
  process.exit(1);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptTemplate = () => fs.readFileSync(path.join(root, 'prompts', 'sales-agent.md'), 'utf8');

// ---- Database (SQLite file in DATA_DIR) ----
fs.mkdirSync(config.dataDir, { recursive: true });
const sqlite = new DatabaseSync(path.join(config.dataDir, 'caller.db'));
sqlite.exec('PRAGMA journal_mode = WAL');
for (const stmt of SCHEMA) sqlite.exec(stmt);
const store = createStore({
  all: async (sql, ...args) => sqlite.prepare(sql).all(...args),
  get: async (sql, ...args) => sqlite.prepare(sql).get(...args) ?? null,
  run: async (sql, ...args) => ({ lastId: Number(sqlite.prepare(sql).run(...args).lastInsertRowid) }),
});

// ---- Email: SMTP if configured, otherwise Resend ----
function smtpSender(cfg) {
  const { smtp, from } = cfg.email;
  if (!smtp.host) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return (to, subject, text) => transport.sendMail({ from: from || smtp.user, to, subject, text, html: textToHtml(text) });
}

// Settings saved in the dashboard are layered over the environment, so each request builds a fresh context.
async function makeCtx() {
  const cfg = buildConfig({ ...process.env, ...(await store.getSettings()) });
  return { config: cfg, env: process.env, store, queue, sendEmail: smtpSender(cfg) || resendSender(cfg.email) };
}

// ---- In-memory call queue: calls go out one at a time ----
const pending = [];
let running = false;
const queue = {
  async enqueue(ids, opts) {
    const { results, accepted } = await prepareBatch(await makeCtx(), ids, opts, pending.map((p) => p.id));
    pending.push(...accepted);
    drain();
    return results;
  },
  state: async () => ({ running, pending: pending.map((p) => p.id) }),
  clear: async () => releaseQueued(await makeCtx(), pending.splice(0)),
};
async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.length) {
      const ctx = await makeCtx();
      const placed = await runQueued(ctx, pending.shift());
      if (placed && pending.length) await new Promise((r) => setTimeout(r, ctx.config.calling.spacingSeconds * 1000));
    }
  } finally {
    running = false;
  }
}

// If a call's result never arrives, don't leave the lead stuck in "calling".
setInterval(() => store.releaseStuckCalls(new Date(Date.now() - 30 * 60 * 1000).toISOString()), 5 * 60 * 1000).unref();

// ---- HTTP ----
const app = express();
app.set('trust proxy', 1);

app.post('/webhooks/elevenlabs', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  const ctx = await makeCtx();
  if (!(await verifyElevenLabsSignature(ctx.config, raw, req.get('elevenlabs-signature')))) return res.status(401).send('bad signature');
  try {
    await handleElevenLabsWebhook(ctx, JSON.parse(raw));
  } catch (err) {
    console.error('webhook error', err);
  }
  res.sendStatus(200);
});

// Twilio call status (OpenAI provider): catches calls that never connected.
app.post('/twilio/status', express.urlencoded({ extended: false }), async (req, res) => {
  const ctx = await makeCtx();
  const url = `${ctx.config.publicUrl}${req.originalUrl}`;
  if (!(await validTwilioSignature(ctx.config.twilio, url, req.body, req.get('x-twilio-signature')))) {
    return res.status(403).send('bad signature');
  }
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(req.body.CallStatus)) {
    await recordNotConnected(ctx, Number(req.query.call), req.body.CallStatus);
  }
  res.type('text/xml').send('<Response/>');
});

app.use(['/api', '/tools'], express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const r = await handleRequest(await makeCtx(), {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      query: req.query,
      body: req.body,
      headers: { cookie: req.get('cookie'), 'x-tool-secret': req.get('x-tool-secret') },
    });
    res.set(r.headers || {}).status(r.status).json(r.json);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(root, 'public')));

const server = app.listen(config.port, () => {
  console.log(`AI caller running on port ${config.port} (public URL ${config.publicUrl}, voice: ${config.voiceProvider})`);
});

// ---- Twilio media streams → OpenAI Realtime ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/media-stream')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, async (twilioWs) => {
    // Buffer Twilio messages until the context is loaded so the "start" event isn't missed.
    const early = [];
    const buffer = (data) => early.push(data.toString());
    twilioWs.on('message', buffer);
    const ctx = await makeCtx();
    const bridge = new CallBridge(ctx, promptTemplate(), {
      sendTwilio: (text) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(text),
      closeTwilio: () => twilioWs.close(),
      connectOpenAI: (url, apiKey, handlers) => new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        ws.on('open', () => resolve({ send: (t) => ws.send(t), close: () => ws.close(), isOpen: () => ws.readyState === WebSocket.OPEN }));
        ws.on('message', (data) => handlers.onMessage(data.toString()));
        ws.on('close', handlers.onClose);
        ws.on('error', (err) => { handlers.onError(err); reject(err); });
      }),
    });
    twilioWs.off('message', buffer);
    twilioWs.on('message', (data) => bridge.onTwilioMessage(data.toString()));
    for (const text of early) await bridge.onTwilioMessage(text);
    twilioWs.on('close', () => bridge.finish());
    twilioWs.on('error', (e) => console.error('twilio ws error', e.message));
  });
});
