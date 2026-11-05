// Starts the real Node server in-process with fake Twilio, OpenAI and email, for end-to-end tests.
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export async function startApp(env = {}) {
  const fake = {
    twilioCalls: [], // bodies of POST /Calls.json
    hangups: [],
    analysis: { outcome: 'link_sent', summary: 'Owner agreed to get the preview.', email: 'o@x.com', next_step: 'Follow up Friday' },
    sessionUpdates: [],
    fromAI: [], // every event the bridge sent to OpenAI
    onSession: null, // (ws) => void: what the fake model does once the session is configured
    connectDelayMs: 0, // slow down the OpenAI handshake
    connections: 0,
    sms: [],
    updates: [], // { sid, twiml } for live calls redirected (transfers)
    failUpdates: false,
    numberUpdates: [], // changes to the Twilio number's settings (incoming call URL)
    calcom: { slots: [], bookings: [], requests: [], fail: null }, // fake Cal.com calendar
    emails: [], // sent through the fake Resend
    lastTwiml: null, // what our server answered to the last signed Twilio webhook
  };

  const openai = new WebSocketServer({
    port: 0,
    verifyClient: (info, cb) => setTimeout(() => cb(true), fake.connectDelayMs),
  });
  await once(openai, 'listening');
  openai.on('connection', (ws) => {
    fake.connections++;
    fake.openaiSocket = ws;
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw);
      fake.fromAI.push(ev);
      if (ev.type === 'session.update') {
        fake.sessionUpdates.push(ev.session);
        fake.onSession?.(ws);
      }
    });
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('api.twilio.com')) {
      const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
      if (url.includes('/IncomingPhoneNumbers.json?')) {
        return new Response(JSON.stringify({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: process.env.TWILIO_FROM_NUMBER }] }));
      }
      if (/\/IncomingPhoneNumbers\/\w+\.json$/.test(url)) {
        fake.numberUpdates.push(body);
        return new Response('{}');
      }
      if (url.endsWith('/Messages.json')) {
        fake.sms.push(body);
        return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
      }
      if (url.endsWith('/Calls.json')) {
        fake.twilioCalls.push(body);
        return new Response(JSON.stringify({ sid: `CA${fake.twilioCalls.length}` }), { status: 201 });
      }
      if (/\/Recordings\/\w+\.mp3$/.test(url)) return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 });
      const m = url.match(/\/Calls\/(\w+)\.json$/);
      if (m && body.Twiml) {
        if (fake.failUpdates) return new Response(JSON.stringify({ message: 'Call is not in-progress' }), { status: 400 });
        fake.updates.push({ sid: m[1], twiml: body.Twiml });
        return new Response('{}');
      }
      if (m) {
        fake.hangups.push(m[1]);
        return new Response('{}');
      }
      return new Response('{}');
    }
    if (url === 'https://api.resend.com/emails') {
      fake.emails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: `em${fake.emails.length}` }));
    }
    if (url.startsWith('https://api.cal.com/v2/')) {
      fake.calcom.requests.push({ url, headers: opts.headers, body: opts.body && JSON.parse(opts.body) });
      if (fake.calcom.fail) return new Response(JSON.stringify({ status: 'error', error: { message: fake.calcom.fail } }), { status: 401 });
      if (url.includes('/v2/slots?')) {
        const q = new URL(url).searchParams;
        const from = Date.parse(q.get('start'));
        const to = Date.parse(q.get('end'));
        const data = {};
        for (const s of fake.calcom.slots) {
          if (Date.parse(s) < from || Date.parse(s) > to) continue;
          (data[s.slice(0, 10)] ??= []).push({ start: s });
        }
        return new Response(JSON.stringify({ status: 'success', data }));
      }
      if (url.endsWith('/v2/bookings')) {
        const body = JSON.parse(opts.body);
        fake.calcom.bookings.push(body);
        return new Response(JSON.stringify({ status: 'success', data: { uid: `bk${fake.calcom.bookings.length}`, start: body.start } }), { status: 201 });
      }
    }
    if (url.includes('chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fake.analysis) } }] }));
    }
    return realFetch(url, opts);
  };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-caller-test-'));
  Object.assign(process.env, {
    DATA_DIR: dataDir, ADMIN_PASSWORD: 'pw', PORT: '0', OPENAI_API_KEY: 'sk-test',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
    OPENAI_REALTIME_URL: `ws://127.0.0.1:${openai.address().port}`,
    CALL_WINDOW_START: '0', CALL_WINDOW_END: '24', CALL_DAYS: '1,2,3,4,5,6,7', CALL_SPACING_SECONDS: '1',
    ...env,
  });
  const { server } = await import('../src/server.js');
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';
  async function api(method, p, body) {
    const res = await realFetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  // A fake Twilio media stream for a call placed through the API.
  // autoAck: confirm audio marks right away (as if playback were instant); false = test does it.
  function mediaStream(twilioCall, { callSid, autoAck = true } = {}) {
    const params = Object.fromEntries([...twilioCall.Twiml.matchAll(/name="(\w+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const wsUrl = twilioCall.Twiml.match(/url="([^"]+)"/)[1].replace(/^wss?:\/\/[^/]+/, `ws://127.0.0.1:${server.address().port}`);
    const ws = new WebSocket(wsUrl);
    const received = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      received.push(m);
      if (m.event === 'mark' && autoAck) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: 'mark', mark: m.mark })), 5);
    });
    const ready = once(ws, 'open').then(() => {
      ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: callSid ?? `CA${fake.twilioCalls.indexOf(twilioCall) + 1}`, customParameters: params } }));
    });
    let ts = 0;
    return {
      ws, received, ready, params,
      media: (n = 1) => { for (let i = 0; i < n; i++) { ts += 20; ws.send(JSON.stringify({ event: 'media', media: { timestamp: String(ts), payload: 'AAAA' } })); } },
      stop: () => ws.send(JSON.stringify({ event: 'stop' })),
    };
  }

  // Signs a Twilio webhook the way Twilio does.
  async function twilioPost(p, params) {
    const url = `${process.env.PUBLIC_URL || 'http://localhost:3000'}${p}`;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const sig = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(data).digest('base64');
    const res = await realFetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams(params),
    });
    fake.lastTwiml = await res.text();
    return res.status;
  }

  const stop = () => {
    server.closeAllConnections?.();
    server.close();
    openai.close();
    globalThis.fetch = realFetch;
  };
  return { fake, api, mediaStream, twilioPost, base, server, stop, realFetch };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 3000, every = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(every);
  }
}
