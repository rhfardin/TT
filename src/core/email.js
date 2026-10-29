// Sends email through Resend's HTTP API (works on Node and Cloudflare Workers).
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const textToHtml = (text) => `<div style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;

export function resendSender(emailConfig) {
  if (!emailConfig.resendApiKey || !emailConfig.from) return null;
  return async (to, subject, text) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${emailConfig.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: emailConfig.from, to: [to], subject, text, html: textToHtml(text) }),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text()}`);
  };
}
