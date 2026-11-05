import { hmacHex, hmacSha1Base64, safeEqual } from './crypto.js';

async function post(tw, path, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(tw.accountSid)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${tw.accountSid}:${tw.authToken}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  }).catch((err) => {
    throw new Error(`Could not reach Twilio (${err.message})`);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio HTTP ${res.status}`);
  return body;
}

async function get(tw, path) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(tw.accountSid)}${path}`, {
    headers: { Authorization: 'Basic ' + btoa(`${tw.accountSid}:${tw.authToken}`) },
  }).catch((err) => {
    throw new Error(`Could not reach Twilio (${err.message})`);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio HTTP ${res.status}`);
  return body;
}

// Points the Twilio number's incoming calls at our /twilio/inbound route.
export async function setInboundUrl(tw, voiceUrl) {
  const list = await get(tw, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(tw.fromNumber)}`);
  const number = list.incoming_phone_numbers?.[0];
  if (!number) throw new Error(`${tw.fromNumber} isn't a number in this Twilio account`);
  // The status callback tells us when an incoming call ends (e.g. they hung up before the AI answered).
  await post(tw, `/IncomingPhoneNumbers/${encodeURIComponent(number.sid)}.json`, {
    VoiceUrl: voiceUrl, VoiceMethod: 'POST',
    StatusCallback: voiceUrl.replace(/\/twilio\/inbound$/, '/twilio/status-inbound'), StatusCallbackMethod: 'POST',
  });
}

// Token the media stream must present, so random clients can't open AI sessions on our bill.
export const streamToken = (tw, callId) => hmacHex(tw.authToken, `stream:${callId}`);

const xmlAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xmlText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Connects the call's audio to our media stream. resume: reconnecting the AI, true after a missed
// transfer, 'keys' after pressing digits in the business's phone menu (digits: what to press first).
export async function streamTwiml(config, callId, { resume = false, digits = '' } = {}) {
  const wsUrl = `${config.publicUrl.replace(/^http/, 'ws')}/media-stream/${callId}`;
  const mode = resume === 'keys' ? 'keys' : resume ? '1' : '';
  return '<Response>' + (digits ? `<Play digits="${xmlAttr(digits)}"/>` : '') +
    `<Connect><Stream url="${xmlAttr(wsUrl)}">` +
    `<Parameter name="callId" value="${callId}"/><Parameter name="token" value="${await streamToken(config.twilio, callId)}"/>` +
    (mode ? `<Parameter name="resume" value="${mode}"/>` : '') +
    '</Stream></Connect></Response>';
}

// Rings the owner. He hears a short summary first and presses 1 to take the call (see whisperTwiml),
// so the business owner never ends up in his voicemail.
export function transferTwiml(config, callId) {
  const u = (p) => xmlAttr(`${config.publicUrl}${p}?call=${callId}`);
  return `<Response><Dial callerId="${xmlAttr(config.twilio.fromNumber)}" timeout="20" action="${u('/twilio/transfer-result')}">` +
    `<Number url="${u('/twilio/whisper')}">${xmlText(config.transfer.phone)}</Number></Dial></Response>`;
}

export function whisperTwiml(config, callId, message) {
  const action = xmlAttr(`${config.publicUrl}/twilio/whisper-answer?call=${callId}`);
  return `<Response><Gather numDigits="1" timeout="8" action="${action}"><Say>${xmlText(message)}</Say>` +
    '<Say>Press 1 to talk to them now.</Say></Gather><Hangup/></Response>';
}

export async function createStreamingCall(config, { to, callId }) {
  const tw = config.twilio;
  const params = {
    To: to,
    From: tw.fromNumber,
    Twiml: await streamTwiml(config, callId),
    StatusCallback: `${config.publicUrl}/twilio/status?call=${callId}`,
    Timeout: '25', // seconds to ring
    TimeLimit: String(config.calling.maxCallSeconds),
  };
  if (config.calling.amdEnabled) {
    // Detection runs in the background while the call is already connected to the AI.
    Object.assign(params, {
      MachineDetection: 'Enable',
      AsyncAmd: 'true',
      AsyncAmdStatusCallback: `${config.publicUrl}/twilio/amd?call=${callId}`,
      AsyncAmdStatusCallbackMethod: 'POST',
    });
  }
  if (config.recordCalls) {
    Object.assign(params, {
      Record: 'true',
      RecordingStatusCallback: `${config.publicUrl}/twilio/recording?call=${callId}`,
      RecordingStatusCallbackEvent: 'completed',
    });
  }
  return post(tw, '/Calls.json', params);
}

// The MP3 of a finished recording (Twilio requires the account's credentials to download it).
// range: the browser's Range header, passed on so audio players can seek (iPhones require it).
export async function fetchRecording(tw, recordingSid, range) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(tw.accountSid)}/Recordings/${encodeURIComponent(recordingSid)}.mp3`, {
    headers: { Authorization: 'Basic ' + btoa(`${tw.accountSid}:${tw.authToken}`), ...(range ? { Range: range } : {}) },
  });
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
  const headers = { 'Accept-Ranges': 'bytes' };
  for (const h of ['Content-Range', 'Content-Length']) if (res.headers.get(h)) headers[h] = res.headers.get(h);
  return { status: res.status, body: await res.arrayBuffer(), headers };
}

export const hangUp = (tw, callSid) => post(tw, `/Calls/${encodeURIComponent(callSid)}.json`, { Status: 'completed' });

// Replaces what a live call is doing with new TwiML (used to hand the call over to a person).
export const updateCall = (tw, callSid, twiml, extra = {}) =>
  post(tw, `/Calls/${encodeURIComponent(callSid)}.json`, { Twiml: twiml, ...extra });

export const sendSms = (tw, to, text) => post(tw, '/Messages.json', { To: to, From: tw.fromNumber, Body: text.slice(0, 1500) });

// https://www.twilio.com/docs/usage/security#validating-requests
export async function validTwilioSignature(tw, url, params, signature) {
  if (!signature || !tw.authToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return safeEqual(await hmacSha1Base64(tw.authToken, data), signature);
}
