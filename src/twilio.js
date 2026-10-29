import crypto from 'node:crypto';
import { config } from './config.js';

const tw = () => config.twilio;
const authHeader = () => 'Basic ' + Buffer.from(`${tw().accountSid}:${tw().authToken}`).toString('base64');
const base = () => `https://api.twilio.com/2010-04-01/Accounts/${tw().accountSid}`;

async function post(path, params) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio HTTP ${res.status}`);
  return body;
}

// Token the media stream must present, so random clients can't open AI sessions on our bill.
export function streamToken(callId) {
  return crypto.createHmac('sha256', tw().authToken).update(`stream:${callId}`).digest('hex');
}

const xmlAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function createStreamingCall({ to, callId }) {
  const wsUrl = config.publicUrl.replace(/^http/, 'ws') + '/media-stream';
  const twiml = `<Response><Connect><Stream url="${xmlAttr(wsUrl)}">` +
    `<Parameter name="callId" value="${callId}"/><Parameter name="token" value="${streamToken(callId)}"/>` +
    '</Stream></Connect></Response>';
  return post('/Calls.json', {
    To: to,
    From: tw().fromNumber,
    Twiml: twiml,
    StatusCallback: `${config.publicUrl}/twilio/status?call=${callId}`,
    Timeout: '25', // seconds to ring
    TimeLimit: String(config.calling.maxCallSeconds),
    Record: config.recordCalls ? 'true' : 'false',
  });
}

export async function hangUp(callSid) {
  return post(`/Calls/${callSid}.json`, { Status: 'completed' });
}

export async function sendSms(to, text) {
  return post('/Messages.json', { To: to, From: tw().fromNumber, Body: text.slice(0, 1500) });
}

// https://www.twilio.com/docs/usage/security#validating-requests
export function validTwilioSignature(url, params, signature) {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', tw().authToken).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
