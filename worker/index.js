// Cloudflare Workers version: Worker + D1 (database) + Durable Objects (live calls, call queue).
// Shares all calling logic with the Node server through src/core.
import { DurableObject } from 'cloudflare:workers';
import promptTemplate from '../prompts/sales-agent.md';
import { buildConfig } from '../src/core/config.js';
import { migrate } from '../src/core/schema.js';
import { createStore } from '../src/core/store.js';
import { handleRequest } from '../src/core/api.js';
import { runDue } from '../src/core/queue.js';
import {
  handleTwilioStatus, handleTwilioAmd, handleTwilioRecording, handleTwilioWhisper, handleTwilioWhisperAnswer,
  handleTwilioTransferResult, handleTwilioInbound, verifyElevenLabsSignature, handleElevenLabsWebhook,
} from '../src/core/actions.js';
import { validTwilioSignature } from '../src/core/twilio.js';
import { resendSender } from '../src/core/email.js';
import { CallBridge } from '../src/core/bridge.js';

// Runs the migrations once per Worker instance.
let schemaReady;
function ensureSchema(env) {
  schemaReady ??= migrate(d1(env.DB)).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function d1(DB) {
  return {
    all: async (sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results,
    get: async (sql, ...args) => (await DB.prepare(sql).bind(...args).first()) ?? null,
    async run(sql, ...args) {
      const { meta } = await DB.prepare(sql).bind(...args).run();
      return { lastId: meta.last_row_id, changes: meta.changes };
    },
    async batch(statements) {
      for (let i = 0; i < statements.length; i += 50) {
        await DB.batch(statements.slice(i, i + 50).map(([sql, ...args]) => DB.prepare(sql).bind(...args)));
      }
    },
  };
}

// publicUrl: PUBLIC_URL if set, otherwise the address the dashboard was opened on.
async function makeCtx(env, publicUrl) {
  await ensureSchema(env);
  const store = createStore(d1(env.DB));
  // Settings saved in the dashboard override wrangler.jsonc vars and secrets.
  const config = buildConfig({ ...env, ...(await store.getSettings()), PUBLIC_URL: env.PUBLIC_URL || publicUrl });
  const ctx = { config, env, store, sendEmail: resendSender(config.email) };
  // The queue is in D1; the Dialer Durable Object only wakes up to work through it.
  ctx.queue = { poke: () => env.DIALER.get(env.DIALER.idFromName('main')).poke(config.publicUrl) };
  return ctx;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  // Cron: housekeeping, and a nudge to the queue in case an alarm was missed.
  async scheduled(event, env) {
    const ctx = await makeCtx(env, '');
    await ctx.store.releaseStuckCalls(new Date(Date.now() - 30 * 60 * 1000).toISOString());
    await ctx.store.purgeAuth();
    await env.DIALER.get(env.DIALER.idFromName('main')).poke();
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Twilio media stream → one Durable Object per call keeps the audio bridge alive.
  if (path.startsWith('/media-stream/')) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const callId = path.split('/')[2];
    return env.CALLS.get(env.CALLS.idFromName(callId)).fetch(request);
  }

  const ctx = await makeCtx(env, url.origin);

  if (request.method === 'POST' && path === '/webhooks/elevenlabs') {
    const raw = await request.text();
    if (!(await verifyElevenLabsSignature(ctx.config, raw, request.headers.get('elevenlabs-signature')))) {
      return new Response('bad signature', { status: 401 });
    }
    await handleElevenLabsWebhook(ctx, JSON.parse(raw));
    return new Response('ok');
  }

  // Twilio callbacks are signed with the auth token; anything unsigned is rejected.
  // A handler may return TwiML telling Twilio what to do next.
  const twilioHandlers = {
    '/twilio/status': handleTwilioStatus,
    '/twilio/amd': handleTwilioAmd,
    '/twilio/recording': handleTwilioRecording,
    '/twilio/whisper': handleTwilioWhisper,
    '/twilio/whisper-answer': handleTwilioWhisperAnswer,
    '/twilio/transfer-result': handleTwilioTransferResult,
    '/twilio/inbound': handleTwilioInbound,
  };
  if (request.method === 'POST' && twilioHandlers[path]) {
    const params = Object.fromEntries(new URLSearchParams(await request.text()));
    const fullUrl = `${ctx.config.publicUrl}${path}${url.search}`;
    if (!(await validTwilioSignature(ctx.config.twilio, fullUrl, params, request.headers.get('x-twilio-signature')))) {
      return new Response('bad signature', { status: 403 });
    }
    const twiml = await twilioHandlers[path](ctx, Number(url.searchParams.get('call')), params);
    return new Response(typeof twiml === 'string' ? twiml : '<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  }

  if (path.startsWith('/api/') || path.startsWith('/tools/')) {
    let body = {};
    if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.json().catch(() => ({}));
    const r = await handleRequest(ctx, {
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      ip: request.headers.get('cf-connecting-ip') || '',
      headers: {
        cookie: request.headers.get('cookie') || '',
        'x-tool-secret': request.headers.get('x-tool-secret') || '',
        'x-requested-with': request.headers.get('x-requested-with') || '',
      },
    });
    if (r.raw) return new Response(r.raw.body, { status: r.status, headers: { 'Content-Type': r.raw.contentType } });
    return json(r.json, r.status, r.headers);
  }

  if (path === '/healthz') return new Response('ok');
  return env.ASSETS.fetch(request);
}

// One instance per phone call: bridges Twilio audio to the OpenAI Realtime API.
export class CallSession extends DurableObject {
  async fetch(request) {
    const ctx = await makeCtx(this.env, new URL(request.url).origin);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    let bridge;
    const closeTwilio = () => {
      try { server.close(1000, 'done'); } catch {}
      bridge.finish().catch((err) => console.error('finish failed', err));
    };
    bridge = new CallBridge(ctx, promptTemplate, {
      sendTwilio: (text) => { try { server.send(text); } catch {} },
      closeTwilio,
      async connectOpenAI(wsUrl, apiKey, handlers) {
        const res = await fetch(wsUrl.replace(/^ws/, 'http'), {
          headers: { Upgrade: 'websocket', Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        const ws = res.webSocket;
        if (!ws) throw new Error(`OpenAI did not accept the connection: HTTP ${res.status} ${await res.text()}`);
        ws.accept();
        let open = true;
        ws.addEventListener('message', (e) => handlers.onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)));
        ws.addEventListener('close', () => { open = false; handlers.onClose(); });
        ws.addEventListener('error', (e) => handlers.onError(e.message || 'websocket error'));
        return {
          send: (text) => ws.send(text),
          close: () => { open = false; try { ws.close(1000, 'call ended'); } catch {} },
          isOpen: () => open,
        };
      },
    });
    server.addEventListener('message', (e) => {
      bridge.onTwilioMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
    });
    server.addEventListener('close', closeTwilio);
    server.addEventListener('error', closeTwilio);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// Wakes up (via alarms) to work through the call queue in D1, one call at a time.
export class Dialer extends DurableObject {
  async poke(publicUrl) {
    if (publicUrl) await this.ctx.storage.put('publicUrl', publicUrl);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  async alarm() {
    let wait = 60 * 1000;
    try {
      const ctx = await makeCtx(this.env, (await this.ctx.storage.get('publicUrl')) || '');
      wait = (await runDue(ctx)).waitMs;
    } catch (err) {
      console.error('queue error', err);
    }
    if (wait !== null) await this.ctx.storage.setAlarm(Date.now() + wait);
  }
}
