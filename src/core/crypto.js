// WebCrypto helpers (available on Node 22 and Cloudflare Workers).
const enc = new TextEncoder();

async function hmac(algo, secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: algo }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

export const hmacHex = async (secret, data) => toHex(await hmac('SHA-256', secret, data));
export const hmacSha1Base64 = async (secret, data) => toBase64(await hmac('SHA-1', secret, data));

export function safeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
