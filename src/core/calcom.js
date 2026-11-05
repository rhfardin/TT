// Cal.com (API v2): open slots and bookings for the owner's event type, so the AI can book calls live.
// cfg = config.calcom = { apiKey, username, eventSlug }

const BASE = 'https://api.cal.com/v2';

export const calcomReady = (cfg) => Boolean(cfg.apiKey && cfg.username && cfg.eventSlug);

async function call(cfg, path, { method = 'GET', version, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'cal-api-version': version,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((err) => {
    throw new Error(`Could not reach Cal.com (${err.message})`);
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === 'error') {
    const msg = json.error?.message || json.message || `Cal.com HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json;
}

// Cal.com has returned slots as { data: { "2026-11-10": [{ start }] } } and as { data: { slots: { ... } } },
// with entries as objects or plain strings; all of them become a sorted list of ISO start times.
export function parseSlots(json) {
  const byDay = json?.data?.slots ?? json?.data ?? {};
  const starts = [];
  for (const list of Object.values(byDay)) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      const start = typeof s === 'string' ? s : s?.start ?? s?.time;
      if (start && !Number.isNaN(Date.parse(start))) starts.push(new Date(start).toISOString());
    }
  }
  return [...new Set(starts)].sort();
}

// Open start times between `from` and `from + days`.
export async function getSlots(cfg, { timeZone, from = new Date(), days = 7 }) {
  const end = new Date(from.getTime() + days * 864e5);
  const q = new URLSearchParams({
    eventTypeSlug: cfg.eventSlug, username: cfg.username, timeZone,
    start: from.toISOString(), end: end.toISOString(),
  });
  return parseSlots(await call(cfg, `/slots?${q}`, { version: '2024-09-04' }));
}

export async function book(cfg, { start, name, email, timeZone, phone, notes }) {
  const json = await call(cfg, '/bookings', {
    method: 'POST',
    version: '2024-08-13',
    body: {
      start,
      eventTypeSlug: cfg.eventSlug,
      username: cfg.username,
      attendee: { name, email, timeZone, ...(phone ? { phoneNumber: phone } : {}) },
      ...(notes ? { metadata: { notes: String(notes).slice(0, 400) } } : {}),
    },
  });
  return { uid: json.data?.uid ?? null, start: json.data?.start ?? start };
}

// "Tuesday, Nov 10 at 10:30 AM" in the business's own timezone.
export function spokenTime(iso, timeZone) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${day} at ${time}`;
}
