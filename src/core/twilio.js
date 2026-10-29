import { hmacHex, hmacSha1Base64, safeEqual } from './crypto.js';

async function post(tw, path, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${tw.accountSid}:${tw.authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio HTTP ${res.status}`);
  return body;
}

// Token the media stream must present, so random clients can't open AI sessions on our bill.
export const streamToken = (tw, callId) => hmacHex(tw.authToken, `stream:${callId}`);

const xmlAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function createStreamingCall(config, { to, callId }) {
  const tw = config.twilio;
  const wsUrl = `${config.publicUrl.replace(/^http/, 'ws')}/media-stream/${callId}`;
  const twiml = `<Response><Connect><Stream url="${xmlAttr(wsUrl)}">` +
    `<Parameter name="callId" value="${callId}"/><Parameter name="token" value="${await streamToken(tw, callId)}"/>` +
    '</Stream></Connect></Response>';
  return post(tw, '/Calls.json', {
    To: to,
    From: tw.fromNumber,
    Twiml: twiml,
    StatusCallback: `${config.publicUrl}/twilio/status?call=${callId}`,
    Timeout: '25', // seconds to ring
    TimeLimit: String(config.calling.maxCallSeconds),
    Record: config.recordCalls ? 'true' : 'false',
  });
}

export const hangUp = (tw, callSid) => post(tw, `/Calls/${callSid}.json`, { Status: 'completed' });

export const sendSms = (tw, to, text) => post(tw, '/Messages.json', { To: to, From: tw.fromNumber, Body: text.slice(0, 1500) });

// https://www.twilio.com/docs/usage/security#validating-requests
export async function validTwilioSignature(tw, url, params, signature) {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(await hmacSha1Base64(tw.authToken, data), signature);
}
