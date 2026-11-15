import crypto from 'node:crypto';

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export function signSession(userId: number, ttlSeconds: number, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(`${userId}.${exp}`);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined, secret: string): number | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [uidRaw, expRaw] = Buffer.from(payload, 'base64url').toString('utf8').split('.');
  const userId = Number(uidRaw);
  const exp = Number(expRaw);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(exp)) return null;
  if (exp * 1000 <= Date.now()) return null;
  return userId;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = 'rplace_session';
