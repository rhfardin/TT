// Node.js server (VPS / Docker / your own computer). The Cloudflare version lives in worker/.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { WebSocketServer, WebSocket } from 'ws';
import { buildConfig } from './core/config.js';
import { migrate } from './core/schema.js';
import { createStore } from './core/store.js';
import { handleRequest } from './core/api.js';
import { runDue } from './core/queue.js';
import {
  handleTwilioStatus, handleTwilioAmd, handleTwilioRecording, handleTwilioWhisper, handleTwilioWhisperAnswer,
  handleTwilioTransferResult, handleTwilioInbound, verifyElevenLabsSignature, handleElevenLabsWebhook,
} from './core/actions.js';
import { validTwilioSignature } from './core/twilio.js';
import { resendSender, textToHtml } from './core/email.js';
import { CallBridge } from './core/bridge.js';
import { openSqlite } from './sqlite.js';

const config = buildConfig(process.env);
if (!config.adminPassword) {
  console.error('ADMIN_PASSWORD must be set.');
  process.exit(1);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptTemplate = () => fs.readFileSync(path.join(root, 'prompts', 'sales-agent.md'), 'utf8');

// ---- Database (SQLite file in DATA_DIR) ----
fs.mkdirSync(config.dataDir, { recursive: true });
const sqlAdapter = openSqlite(path.join(config.dataDir, 'caller.db'));
await migrate(sqlAdapter);
const store = createStore(sqlAdapter);

// A failing request or call must never take the whole server (and every live call) down.
process.on('unhandledRejection', (err) => console.error('unhandled error', err));

// ---- Email: Resend if configured, otherwise SMTP ----
function smtpSender(cfg) {
  const { smtp, from } = cfg.email;
  if (!smtp.host || !smtp.user) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  return (to, subject, text) => transport.sendMail({ from: from || smtp.user, to, subject, text, html: textToHtml(text) });
}

// Settings saved in the dashboard are layered over the environment, so each request builds a fresh context.
async function makeCtx() {
  const cfg = buildConfig({ ...process.env, ...(await store.getSettings()) });
  return { config: cfg, env: process.env, store, queue, sendEmail: resendSender(cfg.email) || smtpSender(cfg) };
}

// ---- Call queue: the queue is in the database; this timer works through it one call at a time ----
let queueTimer = null;
let queueRunning = false;
const queue = { poke: () => scheduleQueue(0) };
function scheduleQueue(ms) {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(runQueue, ms);
  queueTimer.unref();
}
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  let wait = 60 * 1000;
  try {
    wait = (await runDue(await makeCtx())).waitMs ?? wait;
  } catch (err) {
    console.error('queue error', err);
  } finally {
    queueRunning = false;
    scheduleQueue(Math.min(wait, 60 * 1000)); // check at least every minute, for scheduled retries
  }
}
scheduleQueue(2000);

// Housekeeping: calls whose result never arrived, expired sessions.
setInterval(() => {
  store.releaseStuckCalls(new Date(Date.now() - 30 * 60 * 1000).toISOString()).catch((err) => console.error(err));
  store.purgeAuth().catch((err) => console.error(err));
}, 5 * 60 * 1000).unref();

// ---- HTTP ----
const app = express();
app.set('trust proxy', 1);
const route = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
});

app.post('/webhooks/elevenlabs', express.raw({ type: '*/*', limit: '25mb' }), route(async (req, res) => {
  const raw = req.body.toString('utf8');
  const ctx = await makeCtx();
  if (!(await verifyElevenLabsSignature(ctx.config, raw, req.get('elevenlabs-signature')))) return res.status(401).send('bad signature');
  await handleElevenLabsWebhook(ctx, JSON.parse(raw));
  res.sendStatus(200);
}));

// Twilio callbacks are signed with the auth token; anything unsigned is rejected.
// A handler may return TwiML telling Twilio what to do next.
const twilioRoute = (handler) => [express.urlencoded({ extended: false }), route(async (req, res) => {
  const ctx = await makeCtx();
  const url = `${ctx.config.publicUrl}${req.originalUrl}`;
  if (!(await validTwilioSignature(ctx.config.twilio, url, req.body, req.get('x-twilio-signature')))) {
    return res.status(403).send('bad signature');
  }
  const twiml = await handler(ctx, Number(req.query.call), req.body);
  res.type('text/xml').send(typeof twiml === 'string' ? twiml : '<Response/>');
})];
app.post('/twilio/status', ...twilioRoute(handleTwilioStatus));
app.post('/twilio/amd', ...twilioRoute(handleTwilioAmd));
app.post('/twilio/recording', ...twilioRoute(handleTwilioRecording));
app.post('/twilio/whisper', ...twilioRoute(handleTwilioWhisper));
app.post('/twilio/whisper-answer', ...twilioRoute(handleTwilioWhisperAnswer));
app.post('/twilio/transfer-result', ...twilioRoute(handleTwilioTransferResult));
app.post('/twilio/inbound', ...twilioRoute(handleTwilioInbound));

app.use(['/api', '/tools'], express.json({ limit: '20mb' }), route(async (req, res) => {
  const r = await handleRequest(await makeCtx(), {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    query: req.query,
    body: req.body,
    ip: req.ip,
    headers: { cookie: req.get('cookie'), 'x-tool-secret': req.get('x-tool-secret'), 'x-requested-with': req.get('x-requested-with') },
  });
  if (r.raw) return res.status(r.status).type(r.raw.contentType).send(Buffer.from(r.raw.body));
  res.set(r.headers || {}).status(r.status).json(r.json);
}));

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(root, 'public')));

export const server = app.listen(config.port, () => {
  console.log(`AI caller running on port ${server.address().port} (public URL ${config.publicUrl}, voice: ${config.voiceProvider})`);
});

// ---- Twilio media streams → OpenAI Realtime ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/media-stream')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (twilioWs) => startBridge(twilioWs).catch((err) => {
    console.error('media stream error', err);
    twilioWs.close();
  }));
});

async function startBridge(twilioWs) {
  // Hold Twilio messages (and a possible hang-up) until the context is loaded, so nothing is missed.
  const early = [];
  let closedEarly = false;
  const buffer = (data) => early.push(data.toString());
  const onEarlyClose = () => { closedEarly = true; };
  twilioWs.on('message', buffer);
  twilioWs.on('close', onEarlyClose);
  twilioWs.on('error', (e) => console.error('twilio ws error', e.message));
  const ctx = await makeCtx();
  const bridge = new CallBridge(ctx, promptTemplate(), {
    sendTwilio: (text) => twilioWs.readyState === WebSocket.OPEN && twilioWs.send(text),
    closeTwilio: () => twilioWs.close(),
    connectOpenAI: (url, apiKey, handlers) => new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 8000 });
      ws.on('open', () => resolve({ send: (t) => ws.send(t), close: () => ws.close(), isOpen: () => ws.readyState === WebSocket.OPEN }));
      ws.on('message', (data) => handlers.onMessage(data.toString()));
      ws.on('close', handlers.onClose);
      ws.on('error', (err) => { handlers.onError(err); reject(err); });
    }),
  });
  twilioWs.off('message', buffer);
  twilioWs.off('close', onEarlyClose);
  if (closedEarly) return; // hung up before we were ready; Twilio's status callback records it
  twilioWs.on('message', (data) => bridge.onTwilioMessage(data.toString()));
  twilioWs.on('close', () => bridge.finish());
  for (const text of early) await bridge.onTwilioMessage(text);
}
