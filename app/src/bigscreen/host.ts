import { db, getMeta, whereAnyOf } from '../db/db';
import { subsetOracleIds } from '../domain/catalogSubset';
import { onDbChanges, type TableChange } from '../db/changeFeed';
import {
  SessionBook, parseCookies, sessionCookie, clearSessionCookie, deviceLabel, SESSION_COOKIE,
  type BigScreenAuth, type Session,
} from '../domain/bigscreen';
import { TOKEN_KEY } from '../data/tokens';
import { pricesForKeys } from '../data/prices';
import { getCachedNextSet, refreshNextSet } from '../data/nextSet';
import { WRITE_OPS, OpError } from './ops';
import type {
  HostRequest, HostResponse, ServerMsg, Snapshot, PhoneStatus, ReplicaTable, ScanNotice, WriteRequest, CatalogSubset,
} from './protocol';
import type { Card, ScanLog } from '../domain/types';

/**
 * Big Screen am Handy (PLAN.md M18): beantwortet die `/api/*`-Anfragen, die der native
 * Server weiterreicht, verwaltet Anmeldungen und schickt jede Änderung an Sammlung, Decks,
 * Token-Zähler und Fertigdecks mit fortlaufender Nummer an alle Browser. Ohne Android-Teil
 * testbar — der Versand läuft über `deps`.
 */

export interface HostDeps {
  /** An die WebSockets der genannten Sitzungen (ohne Angabe: alle angemeldeten). */
  send(msg: ServerMsg, sessionIds?: string[]): void;
  /** WebSockets dieser Sitzungen schließen (nach einer letzten Nachricht). */
  close(sessionIds: string[], last?: ServerMsg): void;
  now(): number;
  deviceName: string;
  battery?(): Promise<PhoneStatus['battery']>;
  /** Liste der Sitzungen hat sich geändert (für die Anzeige am Handy). */
  onSessions?(sessions: Session[]): void;
}

const REPLICA_TABLES: ReplicaTable[] = ['owned', 'decks', 'ownedPrecons'];
/** Ab so vielen Schlüsseln lieber neu holen lassen als alles einzeln schicken. */
const RESET_THRESHOLD = 2_000;

function json(status: number, body: unknown, headers?: Record<string, string>): HostResponse {
  return { status, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
}

export class BigScreenHost {
  readonly book = new SessionBook();
  private seq = 1;
  private chain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private idleMs: number;
  private auth: BigScreenAuth;

  constructor(private readonly deps: HostDeps, opts: { auth: BigScreenAuth; idleMs: number }) {
    this.auth = opts.auth;
    this.idleMs = opts.idleMs;
    this.unsubscribe = onDbChanges((changes) => {
      this.chain = this.chain.then(() => this.broadcast(changes)).catch(() => {});
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const all = this.book.clear();
    if (all.length) this.deps.close(all.map((s) => s.id), { t: 'bye', reason: 'aus' });
    this.deps.onSessions?.([]);
  }

  setAuth(auth: BigScreenAuth): void {
    this.auth = auth;
  }

  setIdle(ms: number): void {
    this.idleMs = ms;
    void this.status().then((status) => this.deps.send({ t: 'status', status }));
    this.tick();
  }

  /** Regelmäßig aufrufen: abgelaufene Anmeldungen beenden. Gibt die Zahl der Sitzungen zurück. */
  tick(): number {
    const gone = this.book.expire(this.deps.now(), this.idleMs);
    if (gone.length) {
      this.deps.close(gone.map((s) => s.id), { t: 'expired' });
      this.deps.onSessions?.(this.book.list());
    }
    return this.book.size;
  }

  sessions(): Session[] {
    return this.book.list();
  }

  /** Einen Browser am Handy abmelden. */
  kick(id: string): void {
    const s = this.book.removeById(id);
    if (s) {
      this.deps.close([s.id], { t: 'bye', reason: 'abgemeldet' });
      this.deps.onSessions?.(this.book.list());
    }
  }

  private async status(): Promise<PhoneStatus> {
    const [battery, theme] = await Promise.all([this.deps.battery?.().catch(() => undefined), getMeta<string>('theme')]);
    return { device: this.deps.deviceName, idleMs: this.idleMs, ...(theme ? { theme } : {}), ...(battery ? { battery } : {}) };
  }

  private session(req: HostRequest): Session | null {
    return this.book.check(parseCookies(req.cookie)[SESSION_COOKIE], this.deps.now(), this.idleMs);
  }

  async handle(req: HostRequest): Promise<HostResponse> {
    const path = req.path.split('?')[0].replace(/\/+$/, '');
    const method = req.method.toUpperCase();
    try {
      // Ohne Anmeldung: Gerätename und Farbschema, damit schon die Anmeldeseite passt.
      if (method === 'GET' && path === '/api/hello') {
        return json(200, { device: this.deps.deviceName, theme: (await getMeta<string>('theme')) ?? 'violett' });
      }
      if (method === 'GET' && path === '/api/login/challenge') {
        return json(200, { salt: this.auth.salt, iterations: this.auth.iterations, nonce: this.book.challenge(this.deps.now()) });
      }
      if (method === 'POST' && path === '/api/login') {
        const body = JSON.parse(req.body || '{}') as { nonce?: string; proof?: string };
        const res = this.book.login(this.auth, String(body.nonce ?? ''), String(body.proof ?? ''), {
          ip: req.remote ?? '?',
          device: deviceLabel(req.userAgent),
        }, this.deps.now());
        if (!res.ok) {
          if (res.reason === 'gesperrt') return json(429, { error: 'Zu viele Fehlversuche.', retryInMs: res.retryInMs });
          if (res.reason === 'voll') return json(503, { error: 'Schon 8 Browser angemeldet — am Handy einen abmelden.' });
          if (res.reason === 'abgelaufen') return json(401, { error: 'Anmeldung abgelaufen — bitte noch einmal.' });
          return json(401, { error: 'Falsches Passwort.' });
        }
        this.deps.onSessions?.(this.book.list());
        return json(200, { ok: true, session: res.session.id, idleMs: this.idleMs }, { 'Set-Cookie': sessionCookie(res.session.token) });
      }

      // Ab hier nur mit gültiger Anmeldung.
      const s = this.session(req);
      if (!s) return json(401, { error: 'Nicht angemeldet.' }, { 'Set-Cookie': clearSessionCookie() });

      if (method === 'GET' && path === '/api/session') {
        return json(200, { ok: true, session: s.id, device: s.device, idleMs: this.idleMs, status: await this.status() });
      }
      if (method === 'GET' && path === '/api/ws-auth') {
        return json(200, { session: s.id });
      }
      if (method === 'POST' && path === '/api/touch') {
        this.book.touch(s.token, this.deps.now());
        return json(200, { ok: true, idleMs: this.idleMs });
      }
      if (method === 'POST' && path === '/api/logout') {
        this.book.remove(s.token);
        this.deps.close([s.id], { t: 'bye', reason: 'abgemeldet' });
        this.deps.onSessions?.(this.book.list());
        return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
      }
      if (method === 'GET' && path === '/api/snapshot') {
        return json(200, await this.snapshot());
      }
      if (method === 'GET' && path === '/api/catalog-subset') {
        return json(200, await this.catalogSubset());
      }
      // Preise und nächstes Set fürs Browserfenster (M20): Der PC fragt nicht selbst im Internet.
      if (method === 'POST' && path === '/api/prices') {
        const b = JSON.parse(req.body || '{}') as { keys?: unknown; force?: unknown };
        return json(200, { prices: await pricesForKeys(Array.isArray(b.keys) ? b.keys : [], b.force === true) });
      }
      if (method === 'GET' && path === '/api/next-set') {
        return json(200, { next: (await getCachedNextSet()) ?? (await refreshNextSet()) });
      }
      if (method === 'GET' && path === '/api/status') {
        return json(200, await this.status());
      }
      if (method === 'POST' && path === '/api/write') {
        return await this.write(JSON.parse(req.body || '{}') as WriteRequest);
      }
      return json(404, { error: 'Unbekannt.' });
    } catch (e) {
      return json(500, { error: (e as Error).message || 'Fehler am Handy.' });
    }
  }

  /** Die Begrüßung für einen frisch verbundenen WebSocket. */
  async hello(sessionId: string): Promise<ServerMsg> {
    return { t: 'hello', seq: this.seq, session: sessionId, status: await this.status() };
  }

  async snapshot(): Promise<Snapshot> {
    // Erst alle laufenden Meldungen abwarten, damit Stand und Nummer zusammenpassen.
    await this.chain;
    const [owned, decks, ownedPrecons, tokenCount] = await db.transaction('r', db.owned, db.decks, db.ownedPrecons, db.meta, () =>
      Promise.all([db.owned.toArray(), db.decks.toArray(), db.ownedPrecons.toArray(), getMeta<number>(TOKEN_KEY)]));
    return { seq: this.seq, owned, decks, ownedPrecons, tokenCount: typeof tokenCount === 'number' ? tokenCount : 0 };
  }

  /** Katalogdaten der Karten aus Sammlung, Decks und Fertigdecks — der schnelle Start (M20). */
  async catalogSubset(): Promise<CatalogSubset> {
    const [owned, decks, precons] = await Promise.all([db.owned.toArray(), db.decks.toArray(), db.ownedPrecons.toArray()]);
    const ids = subsetOracleIds(owned, decks, precons);
    const [cards, printings, names] = await Promise.all([
      db.cards.bulkGet(ids),
      whereAnyOf(db.printings, 'oracleId', ids),
      whereAnyOf(db.names, 'oracleId', ids),
    ]);
    return { cards: cards.filter((c): c is Card => !!c), printings, names };
  }

  private async write(req: WriteRequest): Promise<HostResponse> {
    const fn = WRITE_OPS[req.op];
    if (!fn) return json(400, { ok: false, error: 'Unbekannter Auftrag.' });
    let result: unknown;
    try {
      result = await fn(Array.isArray(req.args) ? req.args : []);
    } catch (e) {
      return json(e instanceof OpError ? 400 : 409, { ok: false, error: (e as Error).message });
    }
    // Die Änderungsmeldungen laufen nach dem Commit — abwarten, damit `seq` sie schon enthält.
    await new Promise((r) => setTimeout(r, 0));
    await this.chain;
    return json(200, { ok: true, result: result ?? null, seq: this.seq });
  }

  private async broadcast(changes: TableChange[]): Promise<void> {
    for (const c of changes) {
      if (c.table === 'scans') {
        await this.scanNotices(c.keys);
        continue;
      }
      if (c.table === 'meta') {
        if (c.keys?.includes('theme')) this.deps.send({ t: 'status', status: await this.status() });
        if (c.keys?.includes(TOKEN_KEY)) {
          const count = await getMeta<number>(TOKEN_KEY);
          this.deps.send({ t: 'tokens', seq: ++this.seq, count: typeof count === 'number' ? count : 0 });
        }
        continue;
      }
      const table = c.table as ReplicaTable;
      if (!REPLICA_TABLES.includes(table)) continue;
      if (c.keys === null || c.keys.length > RESET_THRESHOLD) {
        this.deps.send({ t: 'reset', seq: ++this.seq });
        continue;
      }
      const rows = await db.table(table).bulkGet(c.keys);
      const puts = rows.filter((r) => r != null);
      const deletes = c.keys.filter((_, i) => rows[i] == null);
      this.deps.send({ t: 'change', seq: ++this.seq, table, puts, deletes });
    }
  }

  private async scanNotices(keys: (string | number)[] | null): Promise<void> {
    const rows: (ScanLog | undefined)[] = keys
      ? await db.scans.bulkGet(keys as number[])
      : await db.scans.orderBy('at').reverse().limit(1).toArray();
    for (const r of rows) {
      if (!r || r.id == null) continue;
      if (r.rejected) {
        this.deps.send({ t: 'scanRejected', id: r.id });
        continue;
      }
      // Nur frische Scans (nicht das Nachtragen von „rejected" an alten Einträgen).
      if (this.deps.now() - r.at > 60_000) continue;
      const scan: ScanNotice = { id: r.id, at: r.at, oracleId: r.chosenOracle, name: r.chosenName, via: r.via };
      this.deps.send({ t: 'scan', scan });
    }
  }
}
