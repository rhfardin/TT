import ExcelJS from 'exceljs';
import { db, logEvent } from './db.js';
import { config } from './config.js';

// Spreadsheet headers are matched loosely (case/spacing/punctuation ignored).
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

export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) return '+' + digits.slice(2);
  if (plus) return '+' + digits;
  const cc = config.calling.defaultCountryCode;
  if (cc === '1' && digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.startsWith('0')) digits = digits.slice(1); // national trunk prefix
  if (digits.length < 7) return null;
  return '+' + cc + digits;
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.hyperlink) return v.hyperlink.replace(/^mailto:/, '');
    if (v.text) return typeof v.text === 'string' ? v.text : v.text.richText?.map((r) => r.text).join('') ?? '';
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}

async function readRows(buffer, filename) {
  if (/\.csv$/i.test(filename)) return parseCsv(buffer.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets[0];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const out = [];
    for (let c = 1; c <= sheet.columnCount; c++) out.push(cellText(r.getCell(c)));
    rows.push(out);
  });
  return rows;
}

export async function importSpreadsheet(buffer, filename) {
  const rows = await readRows(buffer, filename);
  if (rows.length < 2) throw new Error('The sheet needs a header row and at least one business.');
  const headers = rows[0].map(String);
  const mapping = mapHeaders(headers);
  if (mapping.phone === undefined) throw new Error(`Could not find a phone column. Headers found: ${headers.join(', ')}`);
  if (mapping.business_name === undefined) throw new Error(`Could not find a business name column. Headers found: ${headers.join(', ')}`);

  const mappedIdx = new Set(Object.values(mapping));
  const insert = db.prepare(`
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
      extra = excluded.extra
  `);

  let imported = 0;
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (f) => (mapping[f] === undefined ? null : String(r[mapping[f]] ?? '').trim() || null);
    const phone = normalizePhone(get('phone'));
    const name = get('business_name');
    if (!phone || !name) {
      skipped.push({ row: i + 1, reason: !name ? 'no business name' : 'no valid phone' });
      continue;
    }
    const extra = {};
    headers.forEach((h, idx) => {
      if (!mappedIdx.has(idx) && h && r[idx]) extra[h] = r[idx];
    });
    insert.run(name, get('contact_name'), phone, get('email'), get('website'), get('demo_link'),
      get('category'), get('city'), get('timezone'), get('notes'), JSON.stringify(extra));
    imported++;
  }
  logEvent(null, 'import', { filename, imported, skipped: skipped.length });
  const mappedHeaders = Object.fromEntries(Object.entries(mapping).map(([f, i]) => [f, headers[i]]));
  return { imported, skipped, mapping: mappedHeaders };
}
