// Server configuration: the config file (users + passwords) and a few environment variables.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Role = 'admin' | 'mischer';
export const ROLES: readonly Role[] = ['admin', 'mischer'];

export interface ServerConfig {
  /** per user the password: plain text or "scrypt$…" from `npm run hash-password` */
  users: Record<Role, string>;
  /** termine.xlsx, shared settings and the uploaded MP3s (predigten/) live here */
  dataDir: string;
  /** the built web app (dist/) */
  staticDir: string;
  /** signs the login cookies; generated into dataDir if the config does not set one */
  sessionSecret: string | null;
  sessionDays: number;
  maxUploadMb: number;
  /** always set the cookie's Secure flag (otherwise only if the proxy says X-Forwarded-Proto: https) */
  secureCookies: boolean;
  /** the OpenCloud folder the sermons are published to; without it they stay in dataDir/predigten (development) */
  cloud: CloudConfig | null;
}

/** WebDAV access to the shared folder: its WebDAV URL and an app token of a user who may edit it. */
export interface CloudConfig { url: string; user: string; token: string; }

export class ConfigError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  if (!isObject(raw) || !isObject(raw.users)) throw new ConfigError('config: "users" fehlt (siehe config.example.json).');
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const u = raw.users[role];
    const pw = isObject(u) ? u.password : undefined;
    if (typeof pw !== 'string' || !pw) throw new ConfigError(`config: users.${role}.password fehlt.`);
    if (pw.startsWith('CHANGE-ME')) throw new ConfigError(`config: users.${role}.password ist noch der Platzhalter – bitte ein eigenes Passwort eintragen.`);
    if (!pw.startsWith('scrypt$') && pw.length < 8) throw new ConfigError(`config: users.${role}.password ist zu kurz (mindestens 8 Zeichen).`);
    users[role] = pw;
  }
  if (users.admin === users.mischer) throw new ConfigError('config: admin und mischer sollten verschiedene Passwörter haben.');
  const num = (v: unknown, fallback: number, name: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !(v > 0)) throw new ConfigError(`config: ${name} muss eine positive Zahl sein.`);
    return v;
  };
  if (raw.sessionSecret !== undefined && (typeof raw.sessionSecret !== 'string' || raw.sessionSecret.length < 16)) {
    throw new ConfigError('config: sessionSecret muss mindestens 16 Zeichen lang sein (oder weglassen).');
  }
  const secret = typeof raw.sessionSecret === 'string' ? raw.sessionSecret : null;
  let cloud: CloudConfig | null = null;
  if (raw.cloud !== undefined) {
    const c = raw.cloud;
    if (!isObject(c)) throw new ConfigError('config: "cloud" muss ein Objekt mit url, user und token sein.');
    for (const k of ['url', 'user', 'token'] as const) {
      if (typeof c[k] !== 'string' || !c[k].trim()) throw new ConfigError(`config: cloud.${k} fehlt.`);
      if (String(c[k]).startsWith('CHANGE-ME')) throw new ConfigError(`config: cloud.${k} ist noch der Platzhalter.`);
    }
    let url: URL;
    try { url = new URL(String(c.url).trim()); } catch { throw new ConfigError('config: cloud.url ist keine gültige Adresse.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('config: cloud.url muss mit https:// beginnen.');
    // the folder's WebDAV URL as OpenCloud shows it; a trailing slash makes file URLs relative to it
    cloud = { url: url.href.replace(/\/?$/, '/'), user: String(c.user).trim(), token: String(c.token) };
  }
  return {
    users,
    dataDir: resolve(env.DATA_DIR ?? '/data'),
    staticDir: resolve(env.STATIC_DIR ?? 'dist'),
    sessionSecret: secret,
    sessionDays: num(raw.sessionDays, 30, 'sessionDays'),
    maxUploadMb: num(raw.maxUploadMb, 150, 'maxUploadMb'),
    secureCookies: raw.secureCookies === true,
    cloud,
  };
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new ConfigError(`Konfigurationsdatei nicht lesbar: ${file}`); }
  try { return parseConfig(JSON.parse(text), env); } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${file} ist kein gültiges JSON: ${(e as Error).message}`);
  }
}
