// WebCrypto helpers (available on Node 22 and Cloudflare Workers).
const enc = new TextEncoder();

async function hmac(algo, secret, data) {
  if (!secret) throw new Error('missing secret'); // WebCrypto rejects empty keys
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: algo }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

export const hmacHex = async (secret, data) => toHex(await hmac('SHA-256', secret, data));
export const hmacSha1Base64 = async (secret, data) => toBase64(await hmac('SHA-1', secret, data));

export const randomToken = (bytes = 32) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

// Constant-time comparison of equal-length strings (signatures, tokens).
export function safeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// For secrets of any length (passwords): compares digests, so the length isn't leaked either.
export async function secretEqual(a, b) {
  if (!a || !b) return false;
  const digest = async (s) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return safeEqual(await digest(a), await digest(b));
}
