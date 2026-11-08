import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, addOwned, logScan, markScanRejected } from '../db/db';
import { makeAuth, proofFor } from '../domain/bigscreen';
import { BigScreenHost } from './host';
import { applyChange, applySnapshot, SeqTracker } from './replica';
import type { HostResponse, ServerMsg } from './protocol';

vi.mock('../data/backups', () => ({ autoBackup: vi.fn(async () => null) }));

const auth = makeAuth('geheim123', 10, 'ab'.repeat(16));
let now = 1_000_000;
let sent: { msg: ServerMsg; to?: string[] }[];
let closed: { ids: string[]; last?: ServerMsg }[];
let host: BigScreenHost;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  return host.handle({
    id: 'r', method, path, cookie: opts.cookie, remote: '192.168.178.40',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
const body = (r: HostResponse) => JSON.parse(r.body);

async function login(): Promise<string> {
  const ch = body(await req('GET', '/api/login/challenge'));
  const res = await req('POST', '/api/login', { body: { nonce: ch.nonce, proof: proofFor(auth.key, ch.nonce) } });
  expect(res.status).toBe(200);
  return res.headers!['Set-Cookie'].split(';')[0];
}

beforeEach(async () => {
  await Promise.all([db.owned.clear(), db.decks.clear(), db.meta.clear(), db.scans.clear(), db.ownedPrecons.clear(), db.cards.clear()]);
  await db.cards.bulkPut([{ oracleId: 'bolt', name: 'Lightning Bolt', normName: 'lightning bolt', layout: 'normal' }] as never[]);
  sent = [];
  closed = [];
  host = new BigScreenHost({
    send: (msg, to) => sent.push({ msg, to }),
    close: (ids, last) => closed.push({ ids, last }),
    now: () => now,
    deviceName: 'Pixel 8',
  }, { auth, idleMs: 60 * 60_000 });
});
afterEach(() => host.stop());

describe('Anmeldung', () => {
  it('ohne Anmeldung nichts außer Challenge und Login', async () => {
    expect((await req('GET', '/api/snapshot')).status).toBe(401);
    expect((await req('POST', '/api/write', { body: { op: 'addOwned', args: ['bolt'] } })).status).toBe(401);
    const ch = body(await req('GET', '/api/login/challenge'));
    expect(ch).toMatchObject({ salt: auth.salt, iterations: 10 });
    const bad = await req('POST', '/api/login', { body: { nonce: ch.nonce, proof: 'ff'.repeat(32) } });
    expect(bad.status).toBe(401);
    expect(body(bad).error).toMatch(/Falsches Passwort/);
  });

  it('mit Cookie: Sitzung, WebSocket-Freigabe, Abmelden', async () => {
    const cookie = await login();
    const s = body(await req('GET', '/api/session', { cookie }));
    expect(s).toMatchObject({ ok: true, idleMs: 3_600_000, status: { device: 'Pixel 8' } });
    expect(host.sessions()[0].device).toBe('Chrome · Windows');
    expect(body(await req('GET', '/api/ws-auth', { cookie })).session).toBe(s.session);
    const out = await req('POST', '/api/logout', { cookie });
    expect(out.headers!['Set-Cookie']).toMatch(/Max-Age=0/);
    expect(closed).toEqual([{ ids: [s.session], last: { t: 'bye', reason: 'abgemeldet' } }]);
    expect((await req('GET', '/api/session', { cookie })).status).toBe(401);
  });

  it('läuft ohne Eingabe ab, Eingabe verlängert', async () => {
    const cookie = await login();
    now += 50 * 60_000;
    await req('POST', '/api/touch', { cookie });
    now += 50 * 60_000;
    expect(host.tick()).toBe(1);
    now += 11 * 60_000;
    expect(host.tick()).toBe(0);
    expect(closed.at(-1)?.last).toEqual({ t: 'expired' });
  });
});

describe('Lesen und Schreiben', () => {
  it('Schnappschuss, Schreibauftrag → Änderung mit Nummer an alle, Kopie im Browser', async () => {
    await addOwned('bolt', 'nonfoil', 2);
    const cookie = await login();
    const snap = body(await req('GET', '/api/snapshot', { cookie }));
    expect(snap.owned).toHaveLength(1);
    const seq0 = snap.seq;

    const w = body(await req('POST', '/api/write', { cookie, body: { op: 'addOwned', args: ['bolt', 'foil', 1, {}] } }));
    expect(w).toMatchObject({ ok: true, result: 1, seq: seq0 + 1 });
    const change = sent.filter((s) => s.msg.t === 'change').at(-1)!.msg as Extract<ServerMsg, { t: 'change' }>;
    expect(change).toMatchObject({ seq: seq0 + 1, table: 'owned', deletes: [] });
    expect(change.puts).toMatchObject([{ oracleId: 'bolt', finish: 'foil', qty: 1 }]);

    // Der Browser spielt Schnappschuss + Änderung ein (hier in derselben Test-DB).
    const t = new SeqTracker();
    expect(t.accept(change)).toBe('buffer');
    expect(t.synced(seq0)).toEqual([change]);
    await applySnapshot(snap);
    await applyChange(change);
    expect(await db.owned.count()).toBe(2);
  });

  it('kaputte oder unbekannte Aufträge werden abgelehnt', async () => {
    const cookie = await login();
    expect((await req('POST', '/api/write', { cookie, body: { op: 'dropTable', args: [] } })).status).toBe(400);
    const bad = await req('POST', '/api/write', { cookie, body: { op: 'addOwned', args: [42] } });
    expect(bad.status).toBe(400);
    const gone = await req('POST', '/api/write', { cookie, body: { op: 'changeDeck', args: [99, { kind: 'rename', name: 'x' }] } });
    expect(gone.status).toBe(409);
    expect(body(gone).error).toMatch(/gibt es nicht mehr/);
  });

  it('Deck anlegen und Schritt, Token-Zähler, Scans', async () => {
    const cookie = await login();
    sent = [];
    const id = body(await req('POST', '/api/write', { cookie, body: { op: 'createDeck', args: [{ name: 'Burn', format: 'modern' }] } })).result;
    await req('POST', '/api/write', { cookie, body: { op: 'changeDeck', args: [id, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 4 }] } });
    expect((await db.decks.get(id))!.cards).toEqual([{ oracleId: 'bolt', qty: 4 }]);
    await req('POST', '/api/write', { cookie, body: { op: 'addTokens', args: [3] } });
    expect(sent.map((s) => s.msg.t)).toEqual(['change', 'change', 'tokens']);

    const scanId = await logScan({ at: now, ocrRaw: '', chosenOracle: 'bolt', chosenName: 'Lightning Bolt', via: 'bild' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.at(-1)!.msg).toEqual({ t: 'scan', scan: { id: scanId, at: now, oracleId: 'bolt', name: 'Lightning Bolt', via: 'bild' } });
    await markScanRejected(scanId!);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.at(-1)!.msg).toEqual({ t: 'scanRejected', id: scanId });
  });
});

describe('Reihenfolge im Browser', () => {
  it('Lücke → neu holen; Altes überspringen; reset → neu holen', () => {
    const t = new SeqTracker();
    t.synced(5);
    const ch = (seq: number) => ({ t: 'change' as const, seq, table: 'owned' as const, puts: [], deletes: [] });
    expect(t.accept(ch(5))).toBe('skip');
    expect(t.accept(ch(6))).toBe('apply');
    expect(t.accept(ch(8))).toBe('resync');
    t.synced(8);
    expect(t.accept({ t: 'reset', seq: 9 })).toBe('resync');
  });
});
