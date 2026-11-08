import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Big Screen (PLAN.md M18) — reine Logik für Anmeldung und Sitzungen. Läuft am Handy
 * (prüft) und im Browser (rechnet den Nachweis). Über `http://192.168…` gibt es kein
 * `crypto.subtle`, deshalb PBKDF2/HMAC aus @noble/hashes.
 *
 * Ablauf: Das Handy speichert nur Salt + abgeleiteten Schlüssel, nie das Passwort. Zum
 * Anmelden holt der Browser Salt und einen Einmalwert, leitet den Schlüssel aus dem
 * Passwort ab und schickt HMAC(Schlüssel, Einmalwert). Das Passwort geht nie durchs WLAN,
 * eine mitgeschnittene Anmeldung lässt sich nicht wiederholen.
 */

export const PASSWORD_MIN = 6;
export const KDF_ITERATIONS = 200_000;
export const MAX_SESSIONS = 8;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const LOCK_AFTER = 5;
export const LOCK_BASE_MS = 60_000;
/** Big Screen geht von selbst aus, wenn so lange niemand angemeldet ist. */
export const AUTO_OFF_MS = 30 * 60_000;
export const SESSION_COOKIE = 'sg_session';

export const IDLE_OPTIONS: { ms: number; label: string }[] = [
  { ms: 15 * 60_000, label: '15 min' },
  { ms: 60 * 60_000, label: '1 h' },
  { ms: 4 * 60 * 60_000, label: '4 h' },
  { ms: 24 * 60 * 60_000, label: '1 Tag' },
  { ms: 7 * 24 * 60 * 60_000, label: '1 Woche' },
  { ms: 0, label: 'bis Big Screen aus' },
];
export const DEFAULT_IDLE_MS = 60 * 60_000;

/** Gespeichert am Handy (meta `bigscreenAuth`). */
export interface BigScreenAuth {
  salt: string; // hex
  key: string; // hex, PBKDF2-SHA256
  iterations: number;
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b); // geht auch ohne HTTPS
  return bytesToHex(b);
}

export function deriveKey(password: string, saltHex: string, iterations = KDF_ITERATIONS): string {
  return bytesToHex(pbkdf2(sha256, utf8ToBytes(password.normalize('NFC')), hexToBytes(saltHex), { c: iterations, dkLen: 32 }));
}

/** Neues Passwort → was das Handy speichert. */
export function makeAuth(password: string, iterations = KDF_ITERATIONS, salt = randomHex(16)): BigScreenAuth {
  if (password.length < PASSWORD_MIN) throw new Error(`Das Passwort braucht mindestens ${PASSWORD_MIN} Zeichen.`);
  return { salt, key: deriveKey(password, salt, iterations), iterations };
}

export function proofFor(keyHex: string, nonceHex: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(keyHex), hexToBytes(nonceHex)));
}

/** Vergleich ohne Zeitverrat (gleiche Laufzeit unabhängig vom ersten Unterschied). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export interface Session {
  token: string;
  /** kurze ID für Anzeige und WebSocket-Zuordnung (nicht geheim) */
  id: string;
  device: string;
  ip: string;
  createdAt: number;
  lastInputAt: number;
}

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'gesperrt'; retryInMs: number }
  | { ok: false; reason: 'falsch' | 'abgelaufen' | 'voll' };

/** Kurzer Gerätename aus dem User-Agent („Chrome · Windows"). */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPad|iPhone/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/**
 * Sitzungen und Anmeldeversuche, nur im Speicher des Handys. Zeit kommt von außen (`now`),
 * damit sich alles ohne Warten testen lässt.
 */
export class SessionBook {
  private sessions = new Map<string, Session>();
  private challenges = new Map<string, number>(); // nonce → ausgestellt um
  private failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private readonly random: (bytes: number) => string = randomHex) {}

  challenge(now: number): string {
    for (const [n, at] of this.challenges) if (now - at > CHALLENGE_TTL_MS) this.challenges.delete(n);
    const nonce = this.random(32);
    this.challenges.set(nonce, now);
    return nonce;
  }

  /** Anmeldung prüfen. Der Einmalwert gilt genau einmal, auch wenn der Nachweis falsch war. */
  login(
    auth: BigScreenAuth,
    nonce: string,
    proof: string,
    info: { ip: string; device: string },
    now: number,
  ): LoginResult {
    const f = this.failures.get(info.ip);
    if (f && f.lockedUntil > now) return { ok: false, reason: 'gesperrt', retryInMs: f.lockedUntil - now };
    const issued = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (issued == null || now - issued > CHALLENGE_TTL_MS) return { ok: false, reason: 'abgelaufen' };
    if (!safeEqual(proofFor(auth.key, nonce), proof.toLowerCase())) {
      const count = (f?.count ?? 0) + 1;
      const lockedUntil = count >= LOCK_AFTER ? now + LOCK_BASE_MS * 2 ** (count - LOCK_AFTER) : 0;
      this.failures.set(info.ip, { count, lockedUntil });
      return lockedUntil > now ? { ok: false, reason: 'gesperrt', retryInMs: lockedUntil - now } : { ok: false, reason: 'falsch' };
    }
    this.failures.delete(info.ip);
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, reason: 'voll' };
    const session: Session = {
      token: this.random(32),
      id: this.random(6),
      device: info.device,
      ip: info.ip,
      createdAt: now,
      lastInputAt: now,
    };
    this.sessions.set(session.token, session);
    return { ok: true, session };
  }

  /** Gültige Sitzung zum Token — abgelaufene (ohne Eingabe länger als `idleMs`) gelten nicht. */
  check(token: string | undefined, now: number, idleMs: number): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (idleMs > 0 && now - s.lastInputAt > idleMs) return null;
    return s;
  }

  /** Der Mensch im Browser hat etwas getan (Klick, Taste, Scrollen). */
  touch(token: string, now: number): void {
    const s = this.sessions.get(token);
    if (s) s.lastInputAt = Math.max(s.lastInputAt, now);
  }

  /** Abgelaufene Sitzungen entfernen und zurückgeben (zum Schließen ihrer Verbindungen). */
  expire(now: number, idleMs: number): Session[] {
    if (idleMs <= 0) return [];
    const gone: Session[] = [];
    for (const [t, s] of this.sessions) {
      if (now - s.lastInputAt > idleMs) {
        this.sessions.delete(t);
        gone.push(s);
      }
    }
    return gone;
  }

  remove(token: string): Session | undefined {
    const s = this.sessions.get(token);
    this.sessions.delete(token);
    return s;
  }

  removeById(id: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.id === id) return this.remove(s.token);
    return undefined;
  }

  clear(): Session[] {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.challenges.clear();
    return all;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get size(): number {
    return this.sessions.size;
  }
}
