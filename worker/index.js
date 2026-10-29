// Cloudflare Workers version: Worker + D1 (database) + Durable Objects (live calls, call queue).
// Shares all calling logic with the Node server through src/core.
import { DurableObject } from 'cloudflare:workers';
import promptTemplate from '../prompts/sales-agent.md';
import { buildConfig } from '../src/core/config.js';
import { SCHEMA } from '../src/core/schema.js';
import { createStore } from '../src/core/store.js';
import { handleRequest } from '../src/core/api.js';
import { prepareBatch, runQueued, releaseQueued } from '../src/core/queue.js';
import { recordNotConnected, verifyElevenLabsSignature, handleElevenLabsWebhook } from '../src/core/actions.js';
import { validTwilioSignature } from '../src/core/twilio.js';
import { resendSender } from '../src/core/email.js';
import { CallBridge } from '../src/core/bridge.js';

let schemaReady;
function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

function d1(DB) {
  return {
    all: async (sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results,
    get: async (sql, ...args) => (await DB.prepare(sql).bind(...args).first()) ?? null,
    run: async (sql, ...args) => ({ lastId: (await DB.prepare(sql).bind(...args).run()).meta.last_row_id }),
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
  const config = buildConfig({ ...env, PUBLIC_URL: env.PUBLIC_URL || publicUrl });
  const ctx = { config, store: createStore(d1(env.DB)), sendEmail: resendSender(config.email) };
  const dialer = () => env.DIALER.get(env.DIALER.idFromName('main'));
  ctx.queue = {
    enqueue: (ids, opts) => dialer().enqueue(ids, opts, config.publicUrl),
    state: () => dialer().state(),
    clear: () => dialer().clear(),
  };
  return ctx;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
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
      try {
        await handleElevenLabsWebhook(ctx, JSON.parse(raw));
      } catch (err) {
        console.error('webhook error', err);
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && path === '/twilio/status') {
      const params = Object.fromEntries(new URLSearchParams(await request.text()));
      const fullUrl = `${ctx.config.publicUrl}${path}${url.search}`;
      if (!(await validTwilioSignature(ctx.config.twilio, fullUrl, params, request.headers.get('x-twilio-signature')))) {
        return new Response('bad signature', { status: 403 });
      }
      if (['no-answer', 'busy', 'failed', 'canceled'].includes(params.CallStatus)) {
        await recordNotConnected(ctx, Number(url.searchParams.get('call')), params.CallStatus);
      }
      return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
    }

    if (path.startsWith('/api/') || path.startsWith('/tools/')) {
      let body = {};
      if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.json().catch(() => ({}));
      try {
        const r = await handleRequest(ctx, {
          method: request.method,
          path,
          query: Object.fromEntries(url.searchParams),
          body,
          headers: { cookie: request.headers.get('cookie') || '', 'x-tool-secret': request.headers.get('x-tool-secret') || '' },
        });
        return json(r.json, r.status, r.headers);
      } catch (err) {
        console.error(err);
        return json({ error: err.message }, 500);
      }
    }

    if (path === '/healthz') return new Response('ok');
    return env.ASSETS.fetch(request);
  },

  // Cron: leads whose call result never arrived shouldn't stay "calling" forever.
  async scheduled(event, env) {
    const ctx = await makeCtx(env, '');
    await ctx.store.releaseStuckCalls(new Date(Date.now() - 30 * 60 * 1000).toISOString());
  },
};

// One instance per phone call: bridges Twilio audio to the OpenAI Realtime API.
export class CallSession extends DurableObject {
  async fetch(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const ctx = await makeCtx(this.env, new URL(request.url).origin);
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
      bridge.onTwilioMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))
        .catch((err) => console.error('bridge error', err));
    });
    server.addEventListener('close', closeTwilio);
    server.addEventListener('error', closeTwilio);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// The call queue: places queued calls one at a time, CALL_SPACING_SECONDS apart, using alarms.
export class Dialer extends DurableObject {
  async pending() {
    return (await this.ctx.storage.get('pending')) || [];
  }

  async enqueue(ids, opts, publicUrl) {
    await this.ctx.storage.put('publicUrl', publicUrl);
    const ctx = await makeCtx(this.env, publicUrl);
    const pending = await this.pending();
    const { results, accepted } = await prepareBatch(ctx, ids, opts, pending.map((p) => p.id));
    await this.ctx.storage.put('pending', [...pending, ...accepted]);
    if (accepted.length && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return results;
  }

  async state() {
    const pending = await this.pending();
    return { running: pending.length > 0, pending: pending.map((p) => p.id) };
  }

  async clear() {
    const ctx = await makeCtx(this.env, await this.ctx.storage.get('publicUrl'));
    await releaseQueued(ctx, await this.pending());
    await this.ctx.storage.put('pending', []);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const pending = await this.pending();
    const next = pending.shift();
    await this.ctx.storage.put('pending', pending);
    if (!next) return;
    const ctx = await makeCtx(this.env, await this.ctx.storage.get('publicUrl'));
    const placed = await runQueued(ctx, next);
    if (pending.length) await this.ctx.storage.setAlarm(Date.now() + (placed ? ctx.config.calling.spacingSeconds * 1000 : 0));
  }
}
