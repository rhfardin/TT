import nodemailer from 'nodemailer';
import { config } from './config.js';
import { getLead, updateLead, logEvent } from './db.js';
import { sendSms } from './twilio.js';

let transport;
function mailer() {
  if (!config.smtp.host) return null;
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function followUpMessage(lead, name) {
  const s = config.seller;
  const hi = name ? `Hi ${name},` : 'Hi,';
  const lines = [
    hi,
    '',
    `Thanks for taking the call just now. Here is the new website we put together for ${lead.business_name}:`,
    lead.demo_link || lead.website || '',
    '',
  ];
  if (s.bookingLink) lines.push(`If you'd like to go over it together, grab a time here: ${s.bookingLink}`, '');
  if (s.paymentLink) lines.push(`When you're ready to go live, you can get started here: ${s.paymentLink}`, '');
  lines.push('Just reply to this email with any questions or changes you want.', '', s.yourName || '', s.company || '');
  return lines.join('\n').trim();
}

export async function sendDemoLink({ lead_id, email, phone, contact_name, channel }) {
  const lead = getLead(lead_id);
  if (!lead) return { ok: false, message: 'Could not find that business in the system.' };
  const sent = [];
  const text = followUpMessage(lead, contact_name || lead.contact_name);

  const wantsEmail = channel !== 'sms';
  const to = (email || lead.email || '').trim();
  if (wantsEmail && to) {
    const m = mailer();
    if (m) {
      await m.sendMail({
        from: config.smtp.from || config.smtp.user,
        to,
        subject: `Your new website preview - ${lead.business_name}`,
        text,
        html: `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`,
      });
      sent.push(`email to ${to}`);
      if (email && email !== lead.email) updateLead(lead.id, { email });
    }
  }

  const tw = config.twilio;
  if (channel === 'sms' || channel === 'both') {
    const toPhone = (phone || lead.phone || '').trim();
    if (tw.accountSid && tw.authToken && tw.fromNumber && toPhone) {
      try {
        await sendSms(toPhone, text);
        sent.push(`text to ${toPhone}`);
      } catch (err) {
        logEvent(lead.id, 'sms_failed', err.message);
      }
    }
  }

  logEvent(lead.id, 'demo_link_sent', { sent, requested: { email, phone, channel } });
  if (!sent.length) {
    return { ok: false, message: 'The link could not be sent automatically. Tell them the team will send it over shortly.' };
  }
  return { ok: true, message: `Sent the link by ${sent.join(' and ')}.` };
}

export function markDoNotCall({ lead_id, reason }) {
  const lead = getLead(lead_id);
  if (!lead) return { ok: false, message: 'Unknown business.' };
  updateLead(lead.id, { status: 'dnc' });
  logEvent(lead.id, 'do_not_call', reason || 'requested on call');
  return { ok: true, message: 'They have been removed from the call list. Apologize briefly and end the call politely.' };
}
