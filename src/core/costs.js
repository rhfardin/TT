// Estimated cost of a call, from the OpenAI token usage the Realtime API reports and the call's length.
// List prices in US dollars (late 2026); real bills can differ a little. Change them here if prices move.

// Per 1M tokens.
const OPENAI = {
  'gpt-realtime-mini': { audioIn: 10, audioCached: 0.3, audioOut: 20, textIn: 0.6, textCached: 0.06, textOut: 2.4 },
  'gpt-realtime': { audioIn: 32, audioCached: 0.4, audioOut: 64, textIn: 4, textCached: 0.4, textOut: 16 },
};
// Twilio, per minute (billed in whole minutes) or per call.
const TWILIO = { outboundMin: 0.014, inboundMin: 0.0085, streamMin: 0.004, recordingMin: 0.0025, amdCall: 0.0075 };

const n = (v) => Number(v) || 0;

// Adds one response.done usage report to the running total for the call.
export function addUsage(total, usage) {
  if (!usage) return total;
  const i = usage.input_token_details || {};
  const cached = i.cached_tokens_details || {};
  const o = usage.output_token_details || {};
  return {
    audioIn: n(total.audioIn) + n(i.audio_tokens) - n(cached.audio_tokens),
    audioCached: n(total.audioCached) + n(cached.audio_tokens),
    textIn: n(total.textIn) + n(i.text_tokens) - n(cached.text_tokens),
    textCached: n(total.textCached) + n(cached.text_tokens),
    audioOut: n(total.audioOut) + n(o.audio_tokens),
    textOut: n(total.textOut) + n(o.text_tokens),
  };
}

const ratesFor = (model) => (String(model).startsWith('gpt-realtime-mini') ? OPENAI['gpt-realtime-mini'] : OPENAI['gpt-realtime']);

// In cents. answered: the call connected (Twilio bills minutes); seconds: how long it lasted.
export function estimateCostCents({ model, usage = {}, seconds = 0, answered = true, inbound = false, amd = false, recorded = false, extraSeconds = 0 }) {
  const r = ratesFor(model);
  let dollars = 0;
  for (const k of Object.keys(r)) dollars += (n(usage[k]) * r[k]) / 1e6;
  if (answered) {
    const minutes = Math.ceil(n(seconds) / 60);
    dollars += minutes * ((inbound ? TWILIO.inboundMin : TWILIO.outboundMin) + TWILIO.streamMin + (recorded ? TWILIO.recordingMin : 0));
    dollars += Math.ceil(n(extraSeconds) / 60) * TWILIO.outboundMin; // the owner's leg of a live transfer
  }
  if (amd && !inbound) dollars += TWILIO.amdCall;
  return Math.round(dollars * 10000) / 100;
}
