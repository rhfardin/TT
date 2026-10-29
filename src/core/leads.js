// Spreadsheet → lead rows. Pure functions shared by the Node server and the Cloudflare Worker.

// Headers are matched loosely (case/spacing/punctuation ignored).
const ALIASES = {
  business_name: ['business name', 'business', 'company', 'company name', 'name of business', 'practice', 'practice name', 'clinic', 'name'],
  contact_name: ['owner', 'owner name', 'contact', 'contact name', 'first name', 'decision maker', 'doctor'],
  phone: ['phone', 'phone number', 'number', 'mobile', 'telephone', 'tel', 'contact number', 'business phone'],
  email: ['email', 'email address', 'e-mail', 'mail'],
  demo_link: ['demo', 'demo link', 'redesign', 'redesign link', 'redesigned website', 'new website', 'new site', 'preview', 'preview link', 'mockup', 'link', 'redesigned site'],
  website: ['website', 'current website', 'old website', 'site', 'url', 'existing website', 'domain'],
  category: ['category', 'industry', 'niche', 'type', 'business type', 'vertical'],
  city: ['city', 'location', 'area', 'address', 'state'],
  timezone: ['timezone', 'time zone', 'tz'],
  notes: ['notes', 'details', 'detail', 'description', 'info', 'about', 'comments', 'business details'],
};

export const LEAD_FIELDS = Object.keys(ALIASES);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function mapHeaders(headers) {
  const mapping = {};
  const used = new Set();
  // Exact alias matches first, then "header contains alias" as a fallback.
  for (const pass of ['exact', 'contains']) {
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (mapping[field] !== undefined) continue;
      const idx = headers.findIndex((h, i) => {
        if (used.has(i)) return false;
        const n = norm(h);
        return pass === 'exact' ? aliases.includes(n) : aliases.some((a) => a.length > 3 && n.includes(a));
      });
      if (idx !== -1) {
        mapping[field] = idx;
        used.add(idx);
      }
    }
  }
  return mapping;
}

export function normalizePhone(raw, countryCode = '1') {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) return '+' + digits.slice(2);
  if (s.startsWith('+')) return '+' + digits;
  if (countryCode === '1' && digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.startsWith('0')) digits = digits.slice(1); // national trunk prefix
  if (digits.length < 7) return null;
  return '+' + countryCode + digits;
}

// rows: array of arrays of strings, first row = headers.
export function rowsToLeads(rows, countryCode) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('The sheet needs a header row and at least one business.');
  const headers = rows[0].map((h) => String(h ?? ''));
  const mapping = mapHeaders(headers);
  if (mapping.phone === undefined) throw new Error(`Could not find a phone column. Headers found: ${headers.join(', ')}`);
  if (mapping.business_name === undefined) throw new Error(`Could not find a business name column. Headers found: ${headers.join(', ')}`);

  const mappedIdx = new Set(Object.values(mapping));
  const leads = [];
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const get = (f) => (mapping[f] === undefined ? null : String(r[mapping[f]] ?? '').trim() || null);
    const phone = normalizePhone(get('phone'), countryCode);
    const name = get('business_name');
    if (!r.some((x) => String(x ?? '').trim())) continue;
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
    leads.push(lead);
  }
  const mappedHeaders = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, headers[i]]));
  return { leads, skipped, mapping: mappedHeaders };
}

export const UPSERT_LEAD_SQL = `
  INSERT INTO leads (business_name, contact_name, phone, email, website, demo_link, category, city, timezone, notes, extra)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    extra = excluded.extra`;

export const upsertArgs = (l) => [l.business_name, l.contact_name, l.phone, l.email, l.website, l.demo_link,
  l.category, l.city, l.timezone, l.notes, l.extra];

export function localTimeInfo(timezone, defaultTimezone) {
  let tz = timezone || defaultTimezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = defaultTimezone;
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const wd = parts.find((p) => p.type === 'weekday').value;
  const day = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
  return { tz, hour, day };
}

export function canCallNow(lead, calling) {
  const { tz, hour, day } = localTimeInfo(lead.timezone, calling.defaultTimezone);
  if (!calling.days.includes(day)) return { ok: false, reason: `outside calling days in ${tz}` };
  if (hour < calling.windowStartHour || hour >= calling.windowEndHour) {
    return { ok: false, reason: `it is ${hour}:00 in ${tz}; calling window is ${calling.windowStartHour}:00-${calling.windowEndHour}:00` };
  }
  return { ok: true };
}

const DONT_CALL = new Set(['dnc', 'won', 'not_interested']);

export function checkLead(lead, calling, { ignoreWindow = false } = {}) {
  if (!lead) return { ok: false, reason: 'lead not found' };
  if (DONT_CALL.has(lead.status)) return { ok: false, reason: `status is ${lead.status}` };
  if (lead.status === 'calling') return { ok: false, reason: 'a call is already in progress' };
  if (lead.attempts >= calling.maxAttempts) return { ok: false, reason: `already tried ${lead.attempts} times` };
  if (!ignoreWindow) return canCallNow(lead, calling);
  return { ok: true };
}
