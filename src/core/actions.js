// Everything that happens around a call, shared by the Node server and the Cloudflare Worker.
// ctx = { config, store, sendEmail?(to, subject, text) }
import { checkLead } from './leads.js';
import { promptVariables, followUpMessage, OUTCOME_STATUS, OUTCOMES } from './agent.js';
import { createStreamingCall, sendSms } from './twilio.js';
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

  await store.updateLead(lead.id, { status: 'calling', attempts: lead.attempts + 1, last_called_at: new Date().toISOString() });
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
}

export async function recordNotConnected(ctx, callId, reason) {
  const { store } = ctx;
  const call = await store.getCall(callId);
  if (!call || call.status === 'completed') return;
  await store.updateCall(callId, { status: 'no_answer', error: String(reason), ended_at: nowSql() });
  const lead = await store.getLead(call.lead_id);
  if (lead?.status === 'calling') await store.updateLead(lead.id, { status: 'no_answer' });
  await store.logEvent(call.lead_id, 'call_not_connected', reason);
}

// ---- Things the AI can do during the call ----

export async function sendDemoLink(ctx, { lead_id, email, phone, contact_name, channel }) {
  const { config, store } = ctx;
  const lead = await store.getLead(lead_id);
  if (!lead) return { ok: false, message: 'Could not find that business in the system.' };
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
    const toPhone = (phone || lead.phone || '').trim();
    if (tw.accountSid && tw.authToken && tw.fromNumber && toPhone) {
      try {
        await sendSms(tw, toPhone, text);
        sent.push(`text to ${toPhone}`);
      } catch (err) {
        await store.logEvent(lead.id, 'sms_failed', err.message);
      }
    }
  }

  await store.logEvent(lead.id, 'demo_link_sent', { sent, requested: { email, phone, channel } });
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
            '"decision_maker_name": "owner/decision maker name or empty", "next_step": "what the salesperson should do next"}. ' +
            'Use "link_sent" if they agreed to receive the preview, "sold" only if they clearly agreed to buy.',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
  return JSON.parse(body.choices[0].message.content);
}

// ---- ElevenLabs post-call webhook ----

// Header "ElevenLabs-Signature: t=<unix>,v0=<hex>", hex = HMAC-SHA256(secret, `${t}.${rawBody}`).
export async function verifyElevenLabsSignature(config, rawBody, header) {
  const secret = config.elevenlabs.webhookSecret;
  if (!secret) return true; // not configured: accept (set the secret in production!)
  if (!header) return false;
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
