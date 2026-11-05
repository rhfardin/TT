// Everything that happens around a call, shared by the Node server and the Cloudflare Worker.
// ctx = { config, store, sendEmail?(to, subject, text) }
import { checkLead, nextWindowStart, FINAL_STATUSES } from './leads.js';
import { promptVariables, followUpMessage, OUTCOME_STATUS, OUTCOMES } from './agent.js';
import { createStreamingCall, sendSms, hangUp } from './twilio.js';
import { hmacHex, safeEqual } from './crypto.js';

export function providerProblem(config) {
  if (config.voiceProvider === 'elevenlabs') {
    const el = config.elevenlabs;
    return el.apiKey && el.agentId && el.phoneNumberId
      ? null : 'ElevenLabs is not configured (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID).';
  }
  const tw = config.twilio;
  return config.openai.apiKey && tw.accountSid && tw.authToken && tw.fromNumber
    ? null : 'OpenAI calling is not configured (OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).';
}

async function startElevenLabsCall(config, lead) {
  const el = config.elevenlabs;
  const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: { 'xi-api-key': el.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: el.agentId,
      agent_phone_number_id: el.phoneNumberId,
      to_number: lead.phone,
      call_recording_enabled: config.recordCalls,
      conversation_initiation_client_data: { dynamic_variables: promptVariables(lead, config.seller) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const d = body?.detail;
    throw new Error((typeof d === 'object' ? d?.message || JSON.stringify(d) : d) || body?.message || `HTTP ${res.status}`);
  }
  return { conversationId: body.conversation_id ?? null, callSid: body.callSid ?? null };
}

export async function placeCall(ctx, leadId, opts = {}) {
  const { config, store } = ctx;
  const lead = await store.getLead(leadId);
  const check = checkLead(lead, config.calling, opts);
  if (!check.ok) return { ok: false, error: check.reason };
  const problem = providerProblem(config);
  if (problem) return { ok: false, error: problem };
  // Atomic, so a manual call and the queue can never ring the same business twice.
  if (!(await store.claimLeadForCall(lead.id, config.calling.maxAttempts))) {
    return { ok: false, error: 'this business is already being called' };
  }
  const callId = await store.insertCall(lead.id);
  try {
    let conversationId = null;
    let callSid;
    if (config.voiceProvider === 'elevenlabs') {
      ({ conversationId, callSid } = await startElevenLabsCall(config, lead));
    } else {
      callSid = (await createStreamingCall(config, { to: lead.phone, callId })).sid;
    }
    await store.updateCall(callId, { conversation_id: conversationId, call_sid: callSid ?? null, status: 'ringing' });
    await store.logEvent(lead.id, 'call_started', { provider: config.voiceProvider, callSid });
    return { ok: true, callId };
  } catch (err) {
    await store.updateCall(callId, { status: 'failed', error: err.message });
    await store.updateLead(lead.id, { status: 'failed' });
    await store.logEvent(lead.id, 'call_failed', err.message);
    return { ok: false, error: err.message };
  }
}

const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export async function recordCallResult(ctx, callId, { summary, transcript, outcome, collected = {}, duration }) {
  const { store } = ctx;
  const call = await store.getCall(callId);
  if (!call) return;
  const lead = await store.getLead(call.lead_id);
  outcome = String(outcome ?? '').toLowerCase().trim();

  await store.updateCall(callId, {
    status: 'completed', duration_secs: duration ?? null, summary: summary ?? null, ended_at: nowSql(),
    transcript: JSON.stringify(transcript ?? []), outcome: JSON.stringify({ outcome, ...collected }),
  });

  const fields = { last_summary: summary ?? null };
  // A "do not call" set by a tool during the call wins over anything else.
  if (lead.status !== 'dnc') {
    const talked = (transcript ?? []).some((t) => t.role === 'user');
    fields.status = OUTCOME_STATUS[outcome] ?? (talked ? 'completed' : 'no_answer');
  }
  if (collected.meeting_time) fields.meeting_time = String(collected.meeting_time);
  if (collected.email && !lead.email) fields.email = String(collected.email);
  if (collected.decision_maker_name && !lead.contact_name) fields.contact_name = String(collected.decision_maker_name);
  await store.updateLead(lead.id, fields);
  await store.logEvent(lead.id, 'call_completed', { outcome, duration });
  if (fields.status === 'no_answer' || fields.status === 'voicemail') await scheduleRetry(ctx, lead.id, fields.status);
}

export const isMachine = (answeredBy) => /^(machine|fax)/.test(String(answeredBy || ''));

export const recordVoicemail = (ctx, callId, duration = null) => recordCallResult(ctx, callId, {
  summary: 'Reached voicemail or an answering machine; hung up without leaving a message.',
  transcript: [], outcome: 'voicemail', duration,
});

// Businesses in the call list get called again later, at a different time of day each try.
export async function scheduleRetry(ctx, leadId, reason) {
  const { store, config } = ctx;
  const lead = await store.getLead(leadId);
  if (!lead?.in_campaign || lead.is_test || FINAL_STATUSES.includes(lead.status)) return;
  if (lead.attempts >= config.calling.maxAttempts) return;
  const hours = reason === 'voicemail' ? config.calling.retryVoicemailHours : config.calling.retryNoAnswerHours;
  const shift = lead.attempts % 2 ? 3 : -2;
  const at = nextWindowStart(lead, config.calling, new Date(Date.now() + (hours + shift) * 3600 * 1000));
  await store.scheduleLead(lead.id, at.toISOString(), `retry after ${reason}`);
  await store.logEvent(lead.id, 'retry_scheduled', at.toISOString());
  await ctx.queue?.poke?.();
}

// status: 'no_answer' (didn't pick up, busy) or 'failed' (something broke).
export async function recordNotConnected(ctx, callId, reason, status = 'no_answer') {
  const { store } = ctx;
  const call = await store.getCall(callId);
  if (!call || call.status === 'completed') return;
  await store.updateCall(callId, { status, error: String(reason), ended_at: nowSql() });
  const lead = await store.getLead(call.lead_id);
  if (lead?.status === 'calling') await store.updateLead(lead.id, { status: 'no_answer' });
  await store.logEvent(call.lead_id, 'call_not_connected', reason);
  if (status === 'no_answer' && lead?.status === 'calling') await scheduleRetry(ctx, call.lead_id, 'no_answer');
}

// Twilio's call status callback (OpenAI provider).
export async function handleTwilioStatus(ctx, callId, params) {
  const status = params.CallStatus;
  if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) {
    await recordNotConnected(ctx, callId, status, status === 'failed' ? 'failed' : 'no_answer');
  } else if (status === 'completed') {
    // Answered, but our audio stream never connected (wrong PUBLIC_URL, proxy without websockets...).
    const call = await ctx.store.getCall(callId);
    if (call && ['initiated', 'ringing'].includes(call.status) && !isMachine(call.answered_by)) {
      await recordNotConnected(ctx, callId, 'the call was answered but the AI audio never connected; check PUBLIC_URL', 'failed');
    }
  }
}

// Twilio's answering machine detection result (OpenAI provider).
export async function handleTwilioAmd(ctx, callId, params) {
  const call = await ctx.store.getCall(callId);
  if (!call) return;
  await ctx.store.updateCall(callId, { answered_by: params.AnsweredBy || 'unknown' });
  if (!isMachine(params.AnsweredBy)) return;
  try {
    await hangUp(ctx.config.twilio, call.call_sid || params.CallSid);
  } catch (err) {
    await ctx.store.logEvent(call.lead_id, 'hangup_failed', err.message);
  }
  // If the AI audio never started, record it here; otherwise the bridge does when the stream closes.
  if (['initiated', 'ringing'].includes(call.status)) await recordVoicemail(ctx, callId);
}

export async function handleTwilioRecording(ctx, callId, params) {
  if (params.RecordingSid && params.RecordingStatus === 'completed') {
    await ctx.store.updateCall(callId, { recording_sid: params.RecordingSid });
  }
}

// ---- Things the AI can do during the call ----

// Only these arguments are used; the texted number is always the business's own number.
export async function sendDemoLink(ctx, { lead_id, email, contact_name, channel }) {
  const { config, store } = ctx;
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Could not find that business in the system.' };
  if (!lead.demo_link) {
    await store.logEvent(lead.id, 'demo_link_missing', 'no redesign link in the sheet');
    return { ok: false, message: `There is no preview link on file for this business. Tell them ${config.seller.yourName || 'the team'} will email it personally today.` };
  }
  email = typeof email === 'string' ? email.trim() : '';
  const sent = [];
  const text = followUpMessage(lead, contact_name || lead.contact_name, config.seller);

  const to = (email || lead.email || '').trim();
  if (channel !== 'sms' && to && ctx.sendEmail) {
    try {
      await ctx.sendEmail(to, `Your new website preview - ${lead.business_name}`, text);
      sent.push(`email to ${to}`);
      if (email && email !== lead.email) await store.updateLead(lead.id, { email });
    } catch (err) {
      await store.logEvent(lead.id, 'email_failed', err.message);
    }
  }

  const tw = config.twilio;
  if (channel === 'sms' || channel === 'both') {
    const toPhone = lead.phone;
    if (tw.accountSid && tw.authToken && tw.fromNumber && toPhone) {
      try {
        await sendSms(tw, toPhone, text);
        sent.push(`text to ${toPhone}`);
      } catch (err) {
        await store.logEvent(lead.id, 'sms_failed', err.message);
      }
    }
  }

  await store.logEvent(lead.id, 'demo_link_sent', { sent, requested: { email, channel } });
  if (!sent.length) {
    return { ok: false, message: 'The link could not be sent automatically. Tell them the team will send it over shortly.' };
  }
  return { ok: true, message: `Sent the link by ${sent.join(' and ')}.` };
}

export async function markDoNotCall(ctx, { lead_id, reason }) {
  const lead = await ctx.store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Unknown business.' };
  await ctx.store.updateLead(lead.id, { status: 'dnc' });
  await ctx.store.logEvent(lead.id, 'do_not_call', reason || 'requested on call');
  return { ok: true, message: 'They have been removed from the call list. Apologize briefly and end the call politely.' };
}

// ---- After-call analysis (OpenAI provider) ----

export async function analyzeCall(config, lead, transcript, endReason) {
  if (!transcript.some((t) => t.role === 'user')) {
    return { outcome: endReason === 'voicemail' ? 'voicemail' : 'no_answer', summary: 'Nobody spoke on the call.' };
  }
  const text = transcript.map((t) => `${t.role === 'agent' ? 'AI' : 'THEM'}: ${t.message}`).join('\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openai.analysisModel,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You review sales calls offering a website redesign to ${lead.business_name}. Reply with JSON only: ` +
            `{"outcome": one of ${JSON.stringify(OUTCOMES)}, "summary": "2-3 sentences for the salesperson", ` +
            '"meeting_time": "agreed follow-up time or empty", "email": "email they gave or empty", ' +
            '"decision_maker_name": "owner/decision maker name or empty", "next_step": "what the salesperson should do next", ' +
            '"requests": "changes they want, questions the AI could not answer, and anything promised to them, or empty"}. ' +
            'Use "link_sent" if they agreed to receive the preview, "sold" only if they clearly agreed to buy.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  const parsed = JSON.parse(body.choices?.[0]?.message?.content || 'null');
  return parsed && typeof parsed === 'object' ? parsed : {};
}

// ---- ElevenLabs post-call webhook ----

// Header "ElevenLabs-Signature: t=<unix>,v0=<hex>", hex = HMAC-SHA256(secret, `${t}.${rawBody}`).
export async function verifyElevenLabsSignature(config, rawBody, header) {
  const secret = config.elevenlabs.webhookSecret;
  // Without a secret anyone could post fake call results, so the webhook is closed until one is set.
  if (config.voiceProvider !== 'elevenlabs' || !secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v0 || Math.abs(Date.now() / 1000 - t) > 30 * 60) return false;
  return safeEqual(await hmacHex(secret, `${t}.${rawBody}`), parts.v0);
}

const val = (results, key) => {
  const r = results?.[key];
  const v = r && typeof r === 'object' && 'value' in r ? r.value : r;
  return v === undefined || v === null || v === '' ? null : v;
};

export async function handleElevenLabsWebhook(ctx, payload) {
  const { store } = ctx;
  const type = payload?.type;
  const data = payload?.data ?? {};
  const convId = data.conversation_id;
  const dyn = data.conversation_initiation_client_data?.dynamic_variables ?? {};

  let call = convId ? await store.getCallByConversation(convId) : null;
  if (!call && dyn.lead_id && (await store.getLead(dyn.lead_id))) {
    call = { id: await store.insertCall(dyn.lead_id, convId ?? null) };
  }
  if (!call) {
    await store.logEvent(null, 'webhook_unmatched', { type, convId });
    return;
  }

  if (type === 'call_initiation_failure') {
    await recordNotConnected(ctx, call.id, data.failure_reason || data.reason || 'call failed');
    return;
  }
  if (type !== 'post_call_transcription') return; // e.g. post_call_audio is ignored

  const analysis = data.analysis ?? {};
  const results = analysis.data_collection_results ?? {};
  await recordCallResult(ctx, call.id, {
    summary: analysis.transcript_summary ?? null,
    transcript: (data.transcript ?? [])
      .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'user', message: t.message, t: t.time_in_call_secs }))
      .filter((t) => t.message),
    outcome: val(results, 'outcome'),
    collected: Object.fromEntries(Object.keys(results).map((k) => [k, val(results, k)])),
    duration: data.metadata?.call_duration_secs ?? null,
  });
}
