// Passwords, login cookies and brute-force protection.
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Role } from './config';

/** "scrypt$<salt>$<hash>" for the config file (npm run hash-password). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(password, salt, 32).toString('base64')}`;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function verifyPassword(stored: string, given: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    return timingSafeEqual(scryptSync(given, Buffer.from(salt, 'base64'), expected.length), expected);
  }
  return timingSafeEqual(sha(stored), sha(given)); // digests: equal length, no timing leak
}

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** Token "<role>.<expiry>.<signature>". The signature also covers the stored password, so changing it logs everybody out. */
export function signSession(secret: string, role: Role, stored: string, expires: number): string {
  const body = `${role}.${expires}`;
  return `${body}.${hmac(secret, `${body}.${stored}`)}`;
}

export function verifySession(secret: string, users: Record<Role, string>, token: string, now = Date.now()): Role | null {
  const [role, exp, sig] = token.split('.');
  if (role !== 'admin' && role !== 'mischer') return null;
  if (!(Number(exp) > now)) return null;
  const expected = hmac(secret, `${role}.${exp}.${users[role]}`);
  if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return role;
}

/** Blocks an address for a while after too many wrong passwords. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max = 8, private windowMs = 15 * 60_000) {}

  private recent(key: string, now: number) {
    const list = (this.fails.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (list.length) this.fails.set(key, list); else this.fails.delete(key);
    return list;
  }
  /** seconds until the next attempt is allowed, 0 if allowed now */
  blockedFor(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    return list.length >= this.max ? Math.ceil((list[0] + this.windowMs - now) / 1000) : 0;
  }
  fail(key: string, now = Date.now()) {
    // entries are otherwise only cleaned up when the same address comes back
    if (this.fails.size > 10_000) for (const k of [...this.fails.keys()]) this.recent(k, now);
    this.fails.set(key, [...this.recent(key, now), now]);
  }
  reset(key: string) { this.fails.delete(key); }
}
