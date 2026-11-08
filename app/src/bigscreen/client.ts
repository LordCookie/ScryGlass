import { Capacitor } from '@capacitor/core';
import { db, setWriteGateway } from '../db/db';
import { deriveKey, proofFor } from '../domain/bigscreen';
import { applyChange, applySnapshot, clearReplica, SeqTracker } from './replica';
import type {
  BigScreenInfo, ChallengeResponse, PhoneStatus, ScanNotice, SeqMsg, ServerMsg, Snapshot, WriteResponse,
} from './protocol';
import type { Owned } from '../domain/types';
import { followTheme } from '../ui/themes';

/**
 * Big Screen im Browser (PLAN.md M18): Anmelden, Kopie von Sammlung & Decks aktuell halten,
 * Schreibaufträge ans Handy schicken. Ein Zustand für die Oberfläche (`subscribe`/`state`),
 * damit React ohne eigenen Store auskommt.
 */

export type RemotePhase =
  /** prüfe, ob schon angemeldet */
  | 'pruefen'
  | 'anmelden'
  /** angemeldet, Katalog/Kopie werden geladen (RemoteRoot) */
  | 'laden'
  | 'bereit'
  /** keine Eingabe — Anmeldeseite liegt über der App, Kopie bleibt */
  | 'abgelaufen'
  /** Big Screen am Handy ausgeschaltet */
  | 'aus';

export interface ScanEntry extends ScanNotice {
  state: 'korb' | 'uebernommen' | 'verworfen';
}

export interface RemoteState {
  phase: RemotePhase;
  info: BigScreenInfo;
  /** WebSocket steht */
  online: boolean;
  status?: PhoneStatus;
  sessionId?: string;
  loggedInAt?: number;
  scans: ScanEntry[];
  error?: string;
}

const TOUCH_EVERY_MS = 60_000;
const WRITE_WAIT_MS = 3_000;

let info: BigScreenInfo | null = null;

/** Fernbetrieb? Dann kommt die App vom Handy (PLAN.md M18). */
export function isRemote(): boolean {
  return info != null;
}

/** `/bigscreen.json` gibt es nur, wenn das Handy die App ausliefert. */
export async function detectBigScreen(): Promise<BigScreenInfo | null> {
  if (Capacitor.isNativePlatform()) return null;
  try {
    const res = await fetch('/bigscreen.json', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const data = (await res.json()) as BigScreenInfo;
    return data?.mode === 'bigscreen' ? data : null;
  } catch {
    return null;
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

class RemoteClient {
  private st: RemoteState;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private tracker = new SeqTracker();
  private queue: Promise<void> = Promise.resolve();
  private waiters: { seq: number; resolve: () => void }[] = [];
  private retry = 0;
  private retryTimer: number | undefined;
  private lastTouch = 0;
  private inputBound = false;

  constructor(i: BigScreenInfo) {
    this.st = { phase: 'pruefen', info: i, online: false, scans: [] };
  }

  get state(): RemoteState {
    return this.st;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<RemoteState>) {
    if (patch.status?.theme) followTheme(patch.status.theme);
    this.st = { ...this.st, ...patch };
    for (const l of this.listeners) l();
  }

  /** Beim Laden der Seite: schon angemeldet (Cookie)? */
  async check(): Promise<boolean> {
    // Farbschema des Handys schon für die Anmeldeseite.
    void api<{ theme?: string }>('GET', '/api/hello').then((h) => followTheme(h.data.theme)).catch(() => {});
    const r = await api<{ ok?: boolean; session?: string; status?: PhoneStatus }>('GET', '/api/session').catch(() => null);
    if (r?.status === 200 && r.data.ok) {
      this.set({ sessionId: r.data.session, status: r.data.status, phase: 'laden', loggedInAt: Date.now() });
      return true;
    }
    this.set({ phase: this.st.phase === 'abgelaufen' ? 'abgelaufen' : 'anmelden' });
    return false;
  }

  /** Passwort → Nachweis (das Passwort verlässt den Browser nicht). */
  async login(password: string): Promise<string | null> {
    const ch = await api<ChallengeResponse & { error?: string }>('GET', '/api/login/challenge').catch(() => null);
    if (!ch || ch.status !== 200) return 'Das Handy antwortet nicht. Ist Big Screen noch an?';
    // PBKDF2 mit 200.000 Runden dauert einen Moment — vorher die Oberfläche zeichnen lassen.
    await new Promise((r) => setTimeout(r, 30));
    const key = deriveKey(password, ch.data.salt, ch.data.iterations);
    const r = await api<{ ok?: boolean; session?: string; error?: string; retryInMs?: number }>('POST', '/api/login', {
      nonce: ch.data.nonce,
      proof: proofFor(key, ch.data.nonce),
    });
    if (r.status === 200 && r.data.ok) {
      const wasExpired = this.st.phase === 'abgelaufen';
      this.set({ sessionId: r.data.session, phase: wasExpired ? 'bereit' : 'laden', loggedInAt: Date.now(), error: undefined });
      if (wasExpired) await this.connect();
      return null;
    }
    if (r.status === 429) return `Zu viele Fehlversuche — in ${Math.ceil((r.data.retryInMs ?? 60_000) / 1000)} s wieder.`;
    return r.data.error ?? 'Anmeldung fehlgeschlagen.';
  }

  /** Nach dem Laden des Katalogs: WebSocket, Schnappschuss, Schreib-Gateway. */
  async connect(): Promise<void> {
    setWriteGateway((op, args) => this.write(op, args));
    this.bindInput();
    this.openSocket();
    await this.resync();
    if (this.st.phase === 'laden') this.set({ phase: 'bereit' });
  }

  private openSocket() {
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/events`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ online: true });
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        /* kaputte Nachricht ignorieren */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.set({ online: false });
      if (this.st.phase === 'bereit' || this.st.phase === 'laden') this.scheduleReconnect();
    };
  }

  /** Handy schläft oder WLAN weg: immer wieder versuchen, mit wachsendem Abstand. */
  private scheduleReconnect() {
    const delay = [1000, 2000, 5000, 10_000][Math.min(this.retry++, 3)];
    this.retryTimer = window.setTimeout(async () => {
      const ok = await this.check().catch(() => false);
      if (ok) {
        this.set({ phase: 'bereit' });
        this.openSocket();
        await this.resync().catch(() => {});
      } else if (this.st.phase === 'anmelden') {
        // Sitzung weg (Handy neu gestartet): Kopie verstecken, neu anmelden.
        setWriteGateway(null);
      } else this.scheduleReconnect();
    }, delay);
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.set({ status: msg.status, sessionId: msg.session });
        if (this.tracker.seq !== null && msg.seq !== this.tracker.seq) void this.resync();
        return;
      case 'status':
        this.set({ status: msg.status });
        return;
      case 'scan':
        if (!this.st.scans.some((s) => s.id === msg.scan.id)) {
          this.set({ scans: [{ ...msg.scan, state: 'korb' as const }, ...this.st.scans].slice(0, 200) });
        }
        return;
      case 'scanRejected':
        this.set({ scans: this.st.scans.map((s) => (s.id === msg.id ? { ...s, state: 'verworfen' as const } : s)) });
        return;
      case 'expired':
        this.set({ phase: 'abgelaufen', online: false });
        return;
      case 'bye':
        if (msg.reason === 'aus') this.set({ phase: 'aus', online: false });
        else void this.forget();
        return;
      case 'change':
      case 'tokens':
      case 'reset':
        this.queue = this.queue.then(() => this.onSeqMsg(msg)).catch(() => this.resync());
        return;
    }
  }

  private async onSeqMsg(msg: SeqMsg) {
    const what = this.tracker.accept(msg);
    if (what === 'apply' && msg.t !== 'reset') {
      await applyChange(msg);
      if (msg.t === 'change' && msg.table === 'owned') this.markTaken(msg.puts as Owned[]);
      this.release();
    } else if (what === 'resync') {
      await this.resync();
    }
  }

  /** Scans im Korb → „übernommen", sobald der Bestand mit Herkunft „scan" ankommt. */
  private markTaken(puts: Owned[]) {
    const ids = new Set(puts.filter((o) => o.source === 'scan').map((o) => o.oracleId));
    if (!ids.size) return;
    this.set({ scans: this.st.scans.map((s) => (s.state === 'korb' && ids.has(s.oracleId) ? { ...s, state: 'uebernommen' as const } : s)) });
  }

  private resyncing: Promise<void> | null = null;

  /** Schnappschuss holen und einspielen; gepufferte neuere Änderungen danach. */
  resync(): Promise<void> {
    this.resyncing ??= (async () => {
      try {
        this.tracker.invalidate();
        const r = await api<Snapshot>('GET', '/api/snapshot');
        if (r.status === 401) {
          this.set({ phase: 'abgelaufen' });
          return;
        }
        if (r.status !== 200) throw new Error('Schnappschuss fehlgeschlagen');
        await applySnapshot(r.data);
        const later = this.tracker.synced(r.data.seq);
        if (later === 'resync') {
          this.resyncing = null;
          return this.resync();
        }
        for (const m of later) if (m.t !== 'reset') await applyChange(m);
        this.release();
      } finally {
        this.resyncing = null;
      }
    })();
    return this.resyncing;
  }

  private release() {
    const seq = this.tracker.seq ?? -1;
    this.waiters = this.waiters.filter((w) => {
      if (w.seq <= seq) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /** Schreibauftrag ans Handy; zurück erst, wenn die Änderung auch hier angekommen ist. */
  async write(op: string, args: unknown[]): Promise<unknown> {
    this.noteInput();
    let r: { status: number; data: WriteResponse };
    try {
      r = await api<WriteResponse>('POST', '/api/write', { op, args });
    } catch {
      throw new Error('Das Handy antwortet nicht — nichts gespeichert.');
    }
    if (r.status === 401) {
      this.set({ phase: 'abgelaufen' });
      throw new Error('Abgemeldet — nichts gespeichert.');
    }
    if (!r.data.ok) throw new Error(r.data.error || 'Am Handy fehlgeschlagen.');
    const { seq, result } = r.data;
    if ((this.tracker.seq ?? -1) < seq) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          void this.resync().finally(resolve);
        }, WRITE_WAIT_MS);
        this.waiters.push({ seq, resolve: () => { window.clearTimeout(timer); resolve(); } });
      });
    }
    return result;
  }

  /** Klick, Taste, Scrollen: höchstens einmal pro Minute ans Handy melden. */
  private bindInput() {
    if (this.inputBound) return;
    this.inputBound = true;
    const on = () => this.noteInput();
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, on, { passive: true });
  }

  private noteInput() {
    const now = Date.now();
    if (now - this.lastTouch < TOUCH_EVERY_MS || this.st.phase !== 'bereit') return;
    this.lastTouch = now;
    void api('POST', '/api/touch').then((r) => {
      if (r.status === 401) this.set({ phase: 'abgelaufen' });
    }).catch(() => {});
  }

  /** „Verbindung trennen": abmelden, Kopie löschen; auf Wunsch auch den Katalog. */
  async disconnect(opts: { clearCatalog: boolean }): Promise<void> {
    await api('POST', '/api/logout').catch(() => null);
    await this.forget();
    if (opts.clearCatalog) {
      db.close();
      await db.delete();
      location.reload();
    }
  }

  /** Abgemeldet (hier oder am Handy): Kopie weg, zurück zur Anmeldung. */
  private async forget() {
    setWriteGateway(null);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    window.clearTimeout(this.retryTimer);
    this.tracker.invalidate();
    await clearReplica();
    this.set({ phase: 'anmelden', online: false, sessionId: undefined, scans: [] });
  }

  dismissScans() {
    this.set({ scans: [] });
  }
}

let client: RemoteClient | null = null;

export function startRemote(i: BigScreenInfo): RemoteClient {
  info = i;
  client ??= new RemoteClient(i);
  return client;
}

export function remoteClient(): RemoteClient | null {
  return client;
}

export type { RemoteClient };
