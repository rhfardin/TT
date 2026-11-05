import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, mapHeaders, rowsToLeads, leadTimezone, canCallNow, nextWindowStart, checkLead } from '../src/core/leads.js';
import { timezoneFromPhone } from '../src/core/areacodes.js';
import { buildConfig } from '../src/core/config.js';

const calling = buildConfig({}).calling; // 9-17, Mon-Fri, default America/New_York

test('normalizePhone accepts real US numbers in common formats', () => {
  for (const s of ['(512) 555-0100', '512.555.0100', '512-555-0100', '+1 512 555 0100', '1-512-555-0100', '5125550100', 5125550100]) {
    assert.equal(normalizePhone(s), '+15125550100', String(s));
  }
  assert.equal(normalizePhone('(512) 555-0100 ext 56'), '+15125550100');
  assert.equal(normalizePhone('512 555 0100 x12'), '+15125550100');
  assert.equal(normalizePhone('5.1255501E+9'), '+15125550100');
});

test('normalizePhone rejects junk instead of inventing a number', () => {
  for (const s of ['+1', '+', '00', '+1 (TBD)', '555-0100', 'n/a', '', null, '12345678901234567']) {
    assert.equal(normalizePhone(s), null, String(s));
  }
});

test('normalizePhone handles other countries', () => {
  assert.equal(normalizePhone('07911 123456', '44'), '+447911123456');
  assert.equal(normalizePhone('447911123456', '44'), '+447911123456');
  assert.equal(normalizePhone('+44 7911 123456', '1'), '+447911123456');
});

test('mapHeaders ignores social and map links and mailing addresses', () => {
  const headers = ['Business Name', 'Phone Number', 'Google Maps Link', 'LinkedIn', 'Website Link', 'Mailing Address', 'Redesign URL', 'Owner Email'];
  const m = mapHeaders(headers);
  assert.equal(headers[m.website], 'Website Link');
  assert.equal(headers[m.demo_link], 'Redesign URL');
  assert.equal(headers[m.email], 'Owner Email');
  assert.equal(m.city, undefined);
});

test('rowsToLeads merges duplicate phone numbers within one sheet', () => {
  const r = rowsToLeads([
    ['Business', 'Phone', 'Email'],
    ['Glow Spa', '512-555-0100', ''],
    ['Glow Spa', '(512) 555 0100', 'hi@glow.test'],
    ['No Phone', '', ''],
  ], '1');
  assert.equal(r.leads.length, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.leads[0].email, 'hi@glow.test');
  assert.equal(r.skipped.length, 1);
});

test('timezone comes from the sheet, then the area code, then the default', () => {
  assert.equal(timezoneFromPhone('+13105550100'), 'America/Los_Angeles');
  assert.equal(timezoneFromPhone('+19155550100'), 'America/Denver'); // El Paso
  assert.equal(leadTimezone({ phone: '+13105550100', timezone: 'Central' }, calling), 'America/Chicago');
  assert.equal(leadTimezone({ phone: '+13105550100', timezone: 'nonsense' }, calling), 'America/Los_Angeles');
  assert.equal(leadTimezone({ phone: '+447911123456' }, calling), 'America/New_York');
});

test('a Los Angeles business is not called at 9am New York time', () => {
  const nineAmNewYork = new Date('2026-11-04T14:00:00Z'); // Wednesday 9:00 EST = 6:00 PST
  assert.equal(canCallNow({ phone: '+12125550100' }, calling, nineAmNewYork).ok, true);
  assert.equal(canCallNow({ phone: '+13105550100' }, calling, nineAmNewYork).ok, false);
  const next = nextWindowStart({ phone: '+13105550100' }, calling, nineAmNewYork);
  assert.equal(next.toISOString(), '2026-11-04T17:00:00.000Z'); // 9:00 PST
});

test('nextWindowStart skips the weekend', () => {
  const fridayEvening = new Date('2026-11-06T23:00:00Z'); // Fri 18:00 EST
  assert.equal(nextWindowStart({ phone: '+12125550100' }, calling, fridayEvening).toISOString(), '2026-11-09T14:00:00.000Z');
});

test('"EST" in the sheet means New York time, with daylight saving', () => {
  assert.equal(leadTimezone({ phone: '+13105550100', timezone: 'EST' }, calling), 'America/New_York');
  assert.equal(leadTimezone({ phone: '+13105550100', timezone: 'PST' }, calling), 'America/Los_Angeles');
});

test('nextWindowStart is right when the clocks change over the weekend', () => {
  const fridayEvening = new Date('2026-10-30T22:00:00Z'); // Fri 18:00 EDT; clocks go back Sun Nov 1
  assert.equal(nextWindowStart({ phone: '+12125550100' }, calling, fridayEvening).toISOString(), '2026-11-02T14:00:00.000Z'); // Mon 9:00 EST
});

test('checkLead stops final statuses and max attempts', () => {
  assert.equal(checkLead({ status: 'dnc', attempts: 0 }, calling, { ignoreWindow: true }).ok, false);
  assert.equal(checkLead({ status: 'new', attempts: 3 }, calling, { ignoreWindow: true }).ok, false);
  assert.equal(checkLead({ status: 'new', attempts: 0 }, calling, { ignoreWindow: true }).ok, true);
});

test('an "Emailed" column is read as yes/no', () => {
  const r = rowsToLeads([['Business', 'Phone', 'Emailed'], ['A', '5125550100', 'Yes'], ['B', '5125550101', 'no'], ['C', '5125550102', '']], '1');
  assert.deepEqual(r.leads.map((l) => l.emailed), [1, 0, null]);
});

test('days off and the lunch hour are skipped, on the business\'s own calendar', () => {
  const c = { ...calling, noCallDates: ['2026-11-26'], lunchBreak: true }; // Thanksgiving
  const ny = { phone: '+12125550100' };
  const noonNy = new Date('2026-11-25T17:10:00Z'); // Wed 12:10 EST
  assert.equal(canCallNow(ny, c, noonNy).ok, false);
  assert.equal(nextWindowStart(ny, c, noonNy).toISOString(), '2026-11-25T18:00:00.000Z', '1 pm');
  const wedEvening = new Date('2026-11-25T23:00:00Z');
  assert.equal(nextWindowStart(ny, c, wedEvening).toISOString(), '2026-11-27T14:00:00.000Z', 'Friday 9 am, not Thanksgiving');
  // Late Wednesday evening in LA is already Thursday in UTC: the day off follows LA's calendar.
  const la = { phone: '+13105550100' };
  assert.equal(canCallNow(la, c, new Date('2026-11-26T00:30:00Z')).ok, true, 'still Wednesday 4:30 pm in LA');
  assert.equal(canCallNow(la, c, new Date('2026-11-26T18:00:00Z')).ok, false, 'Thursday 10 am in LA');
});
