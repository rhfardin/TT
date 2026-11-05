import { isValidTimezone } from './leads.js';

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
  { key: 'MAX_CALL_SECONDS' },
  { key: 'MAX_CALLS_PER_DAY' },
  { key: 'AMD_ENABLED' },
  { key: 'RETRY_NO_ANSWER_HOURS' },
  { key: 'RETRY_VOICEMAIL_HOURS' },
  { key: 'RECORD_CALLS' },
  { key: 'TRANSFER_ENABLED' },
  { key: 'TRANSFER_PHONE' },
  { key: 'PROMPT_TEMPLATE', long: true },
  { key: 'PROMPT_TEMPLATE_B', long: true },
  { key: 'ALERT_EMAIL' },
  { key: 'FOLLOWUP_DAYS' },
  { key: 'BUSINESS_ADDRESS' },
  { key: 'CALCOM_API_KEY', secret: true },
  { key: 'CALCOM_USERNAME' },
  { key: 'CALCOM_EVENT_SLUG' },
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

const int = (min, max) => (v) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `must be a whole number from ${min} to ${max}`);
const VALIDATE = {
  CALL_WINDOW_START: int(0, 23),
  CALL_WINDOW_END: int(1, 24),
  CALL_SPACING_SECONDS: int(10, 3600),
  MAX_ATTEMPTS: int(1, 10),
  DEFAULT_COUNTRY_CODE: (v) => (/^\d{1,3}$/.test(v) ? null : 'must be 1 to 3 digits, like 1'),
  CALL_DAYS: (v) => (/^[1-7](,[1-7])*$/.test(v) ? null : 'pick at least one day'),
  DEFAULT_TIMEZONE: (v) => (isValidTimezone(v) ? null : 'is not a timezone'),
  MAX_CALL_SECONDS: int(60, 1800),
  MAX_CALLS_PER_DAY: int(1, 1000),
  RETRY_NO_ANSWER_HOURS: int(1, 336),
  RETRY_VOICEMAIL_HOURS: int(1, 336),
  AMD_ENABLED: (v) => (['true', 'false'].includes(v) ? null : 'must be on or off'),
  RECORD_CALLS: (v) => (['true', 'false'].includes(v) ? null : 'must be on or off'),
  TRANSFER_ENABLED: (v) => (['true', 'false'].includes(v) ? null : 'must be on or off'),
  ALERT_EMAIL: (v) => (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v) ? null : 'must be an email address'),
  FOLLOWUP_DAYS: int(0, 30),
  CALCOM_USERNAME: (v) => (/^[\w.-]+$/.test(v) ? null : 'is the part after cal.com/ in your booking link'),
  CALCOM_EVENT_SLUG: (v) => (/^[\w.-]+$/.test(v) ? null : 'is the last part of your event link, like 15min'),
  TRANSFER_PHONE: (v) => (/^\+\d{8,15}$/.test(v) ? null : 'must look like +15551234567'),
  TWILIO_FROM_NUMBER: (v) => (/^\+\d{8,15}$/.test(v) ? null : 'must look like +15551234567'),
};
const LABELS = {
  CALL_WINDOW_START: 'Start hour', CALL_WINDOW_END: 'End hour', CALL_SPACING_SECONDS: 'Seconds between calls',
  MAX_ATTEMPTS: 'Max tries', DEFAULT_COUNTRY_CODE: 'Country code', CALL_DAYS: 'Days', DEFAULT_TIMEZONE: 'Default timezone',
  TWILIO_FROM_NUMBER: 'Twilio phone number', MAX_CALL_SECONDS: 'Max call length', RETRY_NO_ANSWER_HOURS: 'Retry after no answer',
  RETRY_VOICEMAIL_HOURS: 'Retry after voicemail', AMD_ENABLED: 'Voicemail detection', RECORD_CALLS: 'Record calls',
  TRANSFER_ENABLED: 'Live transfer', TRANSFER_PHONE: 'Your phone for transfers', MAX_CALLS_PER_DAY: 'Calls per day',
  CALCOM_USERNAME: 'Cal.com username', CALCOM_EVENT_SLUG: 'Cal.com event',
  ALERT_EMAIL: 'Alert email', FOLLOWUP_DAYS: 'Follow-up email',
};

// Blank secret fields mean "keep the current one"; blank normal fields mean "use the default".
// current: the values in effect now, to check combinations like start hour < end hour.
export function cleanSettingsUpdate(body, current = {}) {
  const values = {};
  const errors = [];
  for (const [key, raw] of Object.entries(body || {})) {
    const def = BY_KEY[key];
    if (!def) continue;
    const value = String(raw ?? '').trim().slice(0, def.long ? 30000 : 10000);
    if (def.secret && !value) continue;
    const problem = value && VALIDATE[key]?.(value);
    if (problem) errors.push(`${LABELS[key]} ${problem}`);
    else values[key] = value;
  }
  const start = Number(values.CALL_WINDOW_START || current.CALL_WINDOW_START || 9);
  const end = Number(values.CALL_WINDOW_END || current.CALL_WINDOW_END || 17);
  if (start >= end) errors.push('Start hour must be before end hour');
  const transferOn = (values.TRANSFER_ENABLED ?? current.TRANSFER_ENABLED) === 'true';
  if (transferOn && !(values.TRANSFER_PHONE ?? current.TRANSFER_PHONE)) errors.push('Add your phone number to turn on live transfer');
  const followupOn = Number(values.FOLLOWUP_DAYS ?? current.FOLLOWUP_DAYS ?? 0) > 0;
  if (followupOn && !(values.BUSINESS_ADDRESS ?? current.BUSINESS_ADDRESS)) {
    errors.push('Add your business postal address to turn on follow-up emails (US law requires it in marketing emails)');
  }
  return { values, errors };
}
