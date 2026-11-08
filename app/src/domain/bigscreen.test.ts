import { describe, it, expect } from 'vitest';
import {
  deriveKey, makeAuth, proofFor, safeEqual, parseCookies, sessionCookie, deviceLabel, SessionBook,
  CHALLENGE_TTL_MS, LOCK_BASE_MS, MAX_SESSIONS, type BigScreenAuth,
} from './bigscreen';

const ITER = 10; // schnell im Test; echt 200.000

describe('Schlüssel und Nachweis', () => {
  it('PBKDF2-SHA256 wie im RFC 7914 (Testvektor)', () => {
    const salt = Array.from(new TextEncoder().encode('salt'), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(deriveKey('passwd', salt, 1)).toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  });

  it('Passwort zu kurz wird abgelehnt; gleiches Passwort → gleicher Schlüssel', () => {
    expect(() => makeAuth('abc', ITER)).toThrow(/mindestens 6/);
    const a = makeAuth('geheim123', ITER, '00112233445566778899aabbccddeeff');
    expect(a.key).toBe(deriveKey('geheim123', a.salt, ITER));
    expect(deriveKey('geheim124', a.salt, ITER)).not.toBe(a.key);
  });

  it('Vergleich, Cookies, Gerätename', () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
    expect(safeEqual('abcd', 'abce')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(parseCookies('a=1; sg_session=xyz ; b=%20')).toEqual({ a: '1', sg_session: 'xyz', b: ' ' });
    expect(sessionCookie('t')).toMatch(/^sg_session=t; HttpOnly; SameSite=Strict/);
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/130 Safari/537')).toBe('Chrome · Windows');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/131')).toBe('Firefox · macOS');
  });
});

describe('Sitzungen', () => {
  let n = 0;
  const book = () => new SessionBook((bytes) => (++n).toString(16).padStart(bytes * 2, "0"));
  const auth: BigScreenAuth = makeAuth('geheim123', ITER, 'aa'.repeat(16));
  const hexNonce = (b: SessionBook, now: number) => b.challenge(now);
  const info = { ip: '192.168.178.40', device: 'Chrome · Windows' };

  it('richtiger Nachweis → Sitzung; Einmalwert gilt nur einmal', () => {
    const b = new SessionBook();
    const nonce = hexNonce(b, 0);
    const res = b.login(auth, nonce, proofFor(auth.key, nonce), info, 10);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(b.check(res.session.token, 20, 60_000)).toBe(res.session);
    expect(b.login(auth, nonce, proofFor(auth.key, nonce), info, 30)).toEqual({ ok: false, reason: 'abgelaufen' });
  });

  it('abgelaufener Einmalwert', () => {
    const b = new SessionBook();
    const nonce = b.challenge(0);
    expect(b.login(auth, nonce, proofFor(auth.key, nonce), info, CHALLENGE_TTL_MS + 1)).toEqual({ ok: false, reason: 'abgelaufen' });
  });

  it('nach 5 Fehlversuchen 1 min Sperre, danach doppelt so lang', () => {
    const b = new SessionBook();
    let now = 0;
    for (let i = 0; i < 4; i++) expect(b.login(auth, b.challenge(now), 'ff'.repeat(32), info, now)).toEqual({ ok: false, reason: 'falsch' });
    expect(b.login(auth, b.challenge(now), 'ff'.repeat(32), info, now)).toEqual({ ok: false, reason: 'gesperrt', retryInMs: LOCK_BASE_MS });
    // Während der Sperre hilft auch das richtige Passwort nicht.
    let nonce = b.challenge(now + 1000);
    expect(b.login(auth, nonce, proofFor(auth.key, nonce), info, now + 1000)).toMatchObject({ ok: false, reason: 'gesperrt' });
    now += LOCK_BASE_MS + 1;
    expect(b.login(auth, b.challenge(now), 'ff'.repeat(32), info, now)).toEqual({ ok: false, reason: 'gesperrt', retryInMs: 2 * LOCK_BASE_MS });
    // Andere Adresse ist nicht gesperrt.
    nonce = b.challenge(now);
    expect(b.login(auth, nonce, proofFor(auth.key, nonce), { ...info, ip: '192.168.178.41' }, now).ok).toBe(true);
  });

  it('läuft ohne Eingabe ab; Eingabe hält sie am Leben; 0 = nie', () => {
    const b = book();
    const nonce = b.challenge(0);
    const res = b.login(auth, nonce, proofFor(auth.key, nonce), info, 0);
    if (!res.ok) throw new Error('login');
    const t = res.session.token;
    b.touch(t, 50_000);
    expect(b.check(t, 100_000, 60_000)).not.toBeNull();
    expect(b.check(t, 111_000, 60_000)).toBeNull();
    expect(b.check(t, 10 ** 12, 0)).not.toBeNull();
    expect(b.expire(111_000, 60_000).map((s) => s.token)).toEqual([t]);
    expect(b.size).toBe(0);
  });

  it(`höchstens ${MAX_SESSIONS} Sitzungen; abmelden per ID`, () => {
    const b = new SessionBook();
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const nonce = b.challenge(0);
      const r = b.login(auth, nonce, proofFor(auth.key, nonce), info, 0);
      if (r.ok) ids.push(r.session.id);
    }
    const nonce = b.challenge(0);
    expect(b.login(auth, nonce, proofFor(auth.key, nonce), info, 0)).toEqual({ ok: false, reason: 'voll' });
    expect(b.removeById(ids[0])?.id).toBe(ids[0]);
    expect(b.list()).toHaveLength(MAX_SESSIONS - 1);
  });
});
