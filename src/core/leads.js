// Spreadsheet → lead rows, phone numbers and calling hours. Pure functions shared by the Node server
// and the Cloudflare Worker.
import { timezoneFromPhone, timezoneAlias } from './areacodes.js';

// Headers are matched loosely (case/spacing/punctuation ignored): exact names first, then "contains".
const ALIASES = {
  business_name: {
    exact: ['business name', 'business', 'company', 'company name', 'name of business', 'practice', 'practice name', 'clinic', 'name'],
    contains: ['business name', 'company name', 'practice name', 'clinic name'],
  },
  contact_name: {
    exact: ['owner', 'owner name', 'contact', 'contact name', 'first name', 'decision maker', 'doctor'],
    contains: ['owner', 'contact name', 'decision maker'],
  },
  phone: {
    exact: ['phone', 'phone number', 'number', 'mobile', 'telephone', 'tel', 'contact number', 'business phone'],
    contains: ['phone', 'telephone'],
  },
  email: {
    exact: ['email', 'email address', 'e-mail', 'e mail', 'mail'],
    contains: ['email', 'e mail'],
  },
  demo_link: {
    exact: ['demo', 'demo link', 'redesign', 'redesign link', 'redesigned website', 'new website', 'new site', 'preview',
      'preview link', 'mockup', 'link', 'redesigned site'],
    contains: ['redesign', 'preview', 'mockup', 'demo', 'new website', 'new site'],
  },
  website: {
    exact: ['website', 'current website', 'old website', 'site', 'url', 'existing website', 'domain', 'website url'],
    contains: ['website', 'web site'],
  },
  category: {
    exact: ['category', 'industry', 'niche', 'type', 'business type', 'vertical'],
    contains: ['category', 'industry', 'niche'],
  },
  city: { exact: ['city', 'location', 'area', 'town'], contains: ['city'] },
  timezone: { exact: ['timezone', 'time zone', 'tz'], contains: ['timezone', 'time zone'] },
  notes: {
    exact: ['notes', 'details', 'detail', 'description', 'info', 'about', 'comments', 'business details'],
    contains: ['notes', 'details', 'description'],
  },
  emailed: { exact: ['emailed', 'email sent', 'emailed before', 'contacted', 'contacted before'], contains: ['emailed', 'email sent'] },
};
// Links that are never the business's website or the redesign preview.
const NOT_A_SITE = /linkedin|facebook|instagram|twitter|tiktok|youtube|yelp|google|maps|review/;

export const LEAD_FIELDS = Object.keys(ALIASES);
const CONTAINS_ORDER = ['emailed', 'email', 'phone', 'timezone', 'demo_link', 'website', 'business_name', 'contact_name', 'category', 'city', 'notes'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function mapHeaders(headers) {
  const mapping = {};
  const used = new Set();
  for (const pass of ['exact', 'contains']) {
    // Specific fields first, so "Owner Email" is an email column, not the owner's name.
    for (const field of CONTAINS_ORDER) {
      const aliases = ALIASES[field];
      if (mapping[field] !== undefined) continue;
      const idx = headers.findIndex((h, i) => {
        if (used.has(i)) return false;
        const n = norm(h);
        if ((field === 'website' || field === 'demo_link') && NOT_A_SITE.test(n)) return false;
        return pass === 'exact' ? aliases.exact.includes(n) : aliases.contains.some((a) => n.includes(a));
      });
      if (idx !== -1) {
        mapping[field] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

// Returns an E.164 number ("+15125550100") or null when it isn't a usable phone number.
export function normalizePhone(raw, countryCode = '1') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0); // Excel scientific notation
  s = s.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, ''); // drop extensions
  let digits = s.replace(/\D/g, '');
  let intl;
  if (s.startsWith('+')) intl = digits;
  else if (s.startsWith('00')) intl = digits.slice(2);
  else if (countryCode === '1') {
    if (digits.length === 11 && digits.startsWith('1')) intl = digits;
    else if (digits.length === 10) intl = '1' + digits;
    else return null;
  } else if (digits.startsWith(countryCode) && digits.length >= countryCode.length + 8) {
    intl = digits; // already has the country code
  } else {
    if (digits.startsWith('0')) digits = digits.slice(1); // national trunk prefix
    intl = countryCode + digits;
  }
  if (intl.length < 8 || intl.length > 15) return null;
  if (intl.startsWith('1') && intl.length !== 11) return null; // North American numbers are +1 and 10 digits
  return '+' + intl;
}

const yesNo = (v) => (v == null ? null : /^(y|yes|true|1|x|sent|✓)$/i.test(v.trim()) ? 1 : /^(n|no|false|0|not sent)$/i.test(v.trim()) ? 0 : null);

// rows: array of arrays of strings, first row = headers.
export function rowsToLeads(rows, countryCode) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('The sheet needs a header row and at least one business.');
  const headers = rows[0].map((h) => String(h ?? ''));
  const mapping = mapHeaders(headers);
  if (mapping.phone === undefined) throw new Error(`Could not find a phone column. Headers found: ${headers.join(', ')}`);
  if (mapping.business_name === undefined) throw new Error(`Could not find a business name column. Headers found: ${headers.join(', ')}`);

  const mappedIdx = new Set(Object.values(mapping));
  const byPhone = new Map();
  const skipped = [];
  let duplicates = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((x) => String(x ?? '').trim())) continue;
    const get = (f) => (mapping[f] === undefined ? null : String(r[mapping[f]] ?? '').trim() || null);
    const phone = normalizePhone(get('phone'), countryCode);
    const name = get('business_name');
    if (!phone || !name) {
      skipped.push({ row: i + 1, reason: !name ? 'no business name' : 'no valid phone' });
      continue;
    }
    const extra = {};
    headers.forEach((h, idx) => {
      if (!mappedIdx.has(idx) && h && r[idx]) extra[h] = String(r[idx]);
    });
    const lead = { phone, extra: JSON.stringify(extra) };
    for (const f of LEAD_FIELDS) if (f !== 'phone') lead[f] = get(f);
    lead.business_name = name;
    lead.emailed = yesNo(lead.emailed);
    // The same number twice in one sheet: later rows fill in what earlier rows left empty.
    const prev = byPhone.get(phone);
    if (prev) {
      duplicates++;
      for (const [k, v] of Object.entries(lead)) if (v) prev[k] = v;
    } else {
      byPhone.set(phone, lead);
    }
  }
  const mappedHeaders = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, headers[i]]));
  return { leads: [...byPhone.values()], skipped, duplicates, mapping: mappedHeaders };
}

export const UPSERT_LEAD_SQL = `
  INSERT INTO leads (business_name, contact_name, phone, email, website, demo_link, category, city, timezone, notes, extra, emailed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(phone) DO UPDATE SET
    business_name = excluded.business_name,
    contact_name = COALESCE(excluded.contact_name, leads.contact_name),
    email = COALESCE(excluded.email, leads.email),
    website = COALESCE(excluded.website, leads.website),
    demo_link = COALESCE(excluded.demo_link, leads.demo_link),
    category = COALESCE(excluded.category, leads.category),
    city = COALESCE(excluded.city, leads.city),
    timezone = COALESCE(excluded.timezone, leads.timezone),
    notes = COALESCE(excluded.notes, leads.notes),
    emailed = COALESCE(excluded.emailed, leads.emailed),
    extra = excluded.extra`;

export const upsertArgs = (l) => [l.business_name, l.contact_name, l.phone, l.email, l.website, l.demo_link,
  l.category, l.city, l.timezone, l.notes, l.extra, l.emailed ?? null];

// ---- Timezones and calling hours ----

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' });
    } catch {
      f = null; // not a real timezone
    }
    formatters.set(tz, f);
  }
  return f;
}
export const isValidTimezone = (tz) => Boolean(tz) && formatter(tz) !== null;

// Sheet value ("America/Chicago", "Central", "PST"), else the phone's area code, else the default.
// Aliases come first: "EST" is also a real but fixed UTC-5 zone that ignores daylight saving time.
export function leadTimezone(lead, calling) {
  for (const tz of [timezoneAlias(lead.timezone), lead.timezone, timezoneFromPhone(lead.phone), calling.defaultTimezone]) {
    if (isValidTimezone(tz)) return tz;
  }
  return 'America/New_York';
}

const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export function localTimeInfo(tz, now = new Date()) {
  const parts = formatter(tz).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { tz, hour: Number(get('hour')), minute: Number(get('minute')), day: DAYS[get('weekday')] };
}

export function canCallNow(lead, calling, now = new Date()) {
  const { tz, hour, day } = localTimeInfo(leadTimezone(lead, calling), now);
  if (!calling.days.includes(day)) return { ok: false, reason: `outside calling days in ${tz}` };
  if (hour < calling.windowStartHour || hour >= calling.windowEndHour) {
    return { ok: false, reason: `it is ${hour}:00 in ${tz}; calling window is ${calling.windowStartHour}:00-${calling.windowEndHour}:00` };
  }
  return { ok: true };
}

// The next moment (at or after `from`) that falls inside the lead's calling window.
export function nextWindowStart(lead, calling, from = new Date()) {
  if (canCallNow(lead, calling, from).ok) return from;
  const { hour, minute, day } = localTimeInfo(leadTimezone(lead, calling), from);
  const nowMin = hour * 60 + minute;
  for (let d = 0; d <= 7; d++) {
    const weekday = ((day - 1 + d) % 7) + 1;
    if (!calling.days.includes(weekday)) continue;
    const ahead = d * 1440 + calling.windowStartHour * 60 - nowMin;
    if (ahead <= 0) continue;
    // Counted in minutes from now, the opening is off by an hour if the clocks change in between: correct it.
    let at = new Date(from.getTime() + ahead * 60000);
    const there = localTimeInfo(leadTimezone(lead, calling), at);
    const drift = calling.windowStartHour * 60 - (there.hour * 60 + there.minute);
    if (drift && Math.abs(drift) <= 120) at = new Date(at.getTime() + drift * 60000);
    return at;
  }
  return new Date(from.getTime() + 24 * 3600 * 1000); // no calling days configured
}

// Statuses that end a lead's calling for good.
export const FINAL_STATUSES = ['dnc', 'won', 'not_interested'];

export function checkLead(lead, calling, { ignoreWindow = false, now = new Date() } = {}) {
  if (!lead) return { ok: false, reason: 'lead not found' };
  if (String(lead.phone).startsWith('hidden:')) return { ok: false, reason: 'they called from a hidden number' };
  if (FINAL_STATUSES.includes(lead.status)) return { ok: false, reason: `status is ${lead.status}` };
  if (lead.status === 'calling') return { ok: false, reason: 'a call is already in progress' };
  if (lead.attempts >= calling.maxAttempts) return { ok: false, reason: `already tried ${lead.attempts} times` };
  if (!ignoreWindow) return canCallNow(lead, calling, now);
  return { ok: true };
}
