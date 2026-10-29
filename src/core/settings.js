// Settings the owner can change from the dashboard. Saved values override environment variables.
export const SETTINGS = [
  { key: 'OPENAI_API_KEY', secret: true },
  { key: 'TWILIO_ACCOUNT_SID' },
  { key: 'TWILIO_AUTH_TOKEN', secret: true },
  { key: 'TWILIO_FROM_NUMBER' },
  { key: 'OPENAI_REALTIME_MODEL' },
  { key: 'OPENAI_VOICE' },
  { key: 'AGENT_NAME' },
  { key: 'YOUR_NAME' },
  { key: 'YOUR_COMPANY' },
  { key: 'OFFER_PRICE' },
  { key: 'BOOKING_LINK' },
  { key: 'PAYMENT_LINK' },
  // "What the AI knows": answers from the owner's questionnaire, used on every call.
  { key: 'KB_ABOUT' },
  { key: 'KB_INCLUDED' },
  { key: 'KB_PRICING' },
  { key: 'KB_TIMELINE' },
  { key: 'KB_PROCESS' },
  { key: 'KB_GUARANTEE' },
  { key: 'KB_PROOF' },
  { key: 'KB_FAQ' },
  { key: 'KB_NEVER' },
  { key: 'KB_CLOSE' },
  { key: 'RESEND_API_KEY', secret: true },
  { key: 'EMAIL_FROM' },
  { key: 'DEFAULT_TIMEZONE' },
  { key: 'DEFAULT_COUNTRY_CODE' },
  { key: 'CALL_WINDOW_START' },
  { key: 'CALL_WINDOW_END' },
  { key: 'CALL_DAYS' },
  { key: 'CALL_SPACING_SECONDS' },
  { key: 'MAX_ATTEMPTS' },
];
const BY_KEY = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

// What the dashboard sees: secrets are never sent back, only whether they're set.
export function settingsForDashboard(env, saved) {
  const out = {};
  for (const { key, secret } of SETTINGS) {
    const value = saved[key] ?? env[key] ?? '';
    out[key] = secret ? { set: Boolean(value), hint: value ? `…${String(value).slice(-4)}` : '' } : String(value);
  }
  return out;
}

// Blank secret fields mean "keep the current one".
export function cleanSettingsUpdate(body) {
  const out = {};
  for (const [key, raw] of Object.entries(body || {})) {
    const def = BY_KEY[key];
    if (!def) continue;
    const value = String(raw ?? '').trim();
    if (def.secret && !value) continue;
    out[key] = value;
  }
  return out;
}
