import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { getMeta, setMeta } from '../db/db';
import { makeAuth, AUTO_OFF_MS, DEFAULT_IDLE_MS, type BigScreenAuth, type Session } from '../domain/bigscreen';
import { BigScreen } from '../native/bigScreen';
import { getDeviceName } from '../peer/peerStore';
import { APP_VERSION } from '../version';
import { BigScreenHost } from './host';
import { BIGSCREEN_PORTS } from './protocol';
import { CATALOG_BASE_URL, fetchRemoteVersion, getLocalCatalogVersion } from '../data/catalog';
import { liveCatalogVersion, stageCatalog, promoteStagedCatalog, dropStagedCatalog } from '../data/catalogStage';
import { REMOTE_CATALOG_BASE, startCatalogUpdate } from '../data/updates';
import { isNewerCatalog } from '../domain/updates';

/**
 * Big Screen am Handy (PLAN.md M18): einschalten, Passwort, Sitzungen, Wachmodus mit
 * Ruhebild. Ein kleiner Zustand für die Oberfläche (`subscribe`/`state`).
 */

const AUTH_KEY = 'bigscreenAuth';
const IDLE_KEY = 'bigscreenIdleMs';
/** Nach so langer Zeit ohne Berührung (und nicht im Scanner) kommt das Ruhebild. */
export const DIM_AFTER_MS = 2 * 60_000;

export interface PhoneState {
  ready: boolean;
  running: boolean;
  busy: boolean;
  url?: string;
  error?: string;
  hasPassword: boolean;
  idleMs: number;
  sessions: Session[];
  dimmed: boolean;
  charging?: boolean;
}

let st: PhoneState = { ready: false, running: false, busy: false, hasPassword: false, idleMs: DEFAULT_IDLE_MS, sessions: [], dimmed: false };
const listeners = new Set<() => void>();
let host: BigScreenHost | null = null;
let handles: PluginListenerHandle[] = [];
let timers: number[] = [];
let lastTouch = Date.now();
let noSessionSince = Date.now();
let scannerActive = false;

function set(patch: Partial<PhoneState>) {
  st = { ...st, ...patch };
  for (const l of listeners) l();
}

export const bigScreenPhone = {
  get state(): PhoneState {
    return st;
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function bigScreenAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function initBigScreenPhone(): Promise<void> {
  if (st.ready) return;
  const [auth, idle] = await Promise.all([getMeta<BigScreenAuth>(AUTH_KEY), getMeta<number>(IDLE_KEY)]);
  set({ ready: true, hasPassword: !!auth, idleMs: typeof idle === 'number' ? idle : DEFAULT_IDLE_MS });
}

/** Neues Passwort; laufende Anmeldungen bleiben gültig, neue brauchen das neue. */
export async function setBigScreenPassword(password: string): Promise<void> {
  // PBKDF2 mit 200.000 Runden dauert am Handy etwas — Oberfläche vorher zeichnen lassen.
  await new Promise((r) => setTimeout(r, 30));
  const auth = makeAuth(password);
  await setMeta(AUTH_KEY, auth);
  host?.setAuth(auth);
  set({ hasPassword: true });
}

export async function setBigScreenIdle(ms: number): Promise<void> {
  await setMeta(IDLE_KEY, ms);
  host?.setIdle(ms);
  set({ idleMs: ms });
}

export async function startBigScreen(): Promise<void> {
  if (st.running || st.busy) return;
  const auth = await getMeta<BigScreenAuth>(AUTH_KEY);
  if (!auth) {
    set({ error: 'Erst ein Passwort festlegen.' });
    return;
  }
  set({ busy: true, error: undefined });
  try {
    const deviceName = await getDeviceName();
    host = new BigScreenHost({
      send: (msg, sessions) => void BigScreen.send({ data: JSON.stringify(msg), ...(sessions ? { sessions } : {}) }),
      close: (sessions, last) => void BigScreen.close({ sessions, ...(last ? { data: JSON.stringify(last) } : {}) }),
      now: () => Date.now(),
      deviceName,
      battery: async () => {
        const b = await BigScreen.battery();
        if (b.level == null) return undefined;
        set({ charging: !!b.charging });
        return { level: b.level, charging: !!b.charging };
      },
      onSessions: (sessions) => {
        if (sessions.length) noSessionSince = Date.now();
        else if (st.sessions.length) noSessionSince = Date.now();
        // Nur angemeldete Browser bekommen Kartenbilder vom Handy (M20).
        void BigScreen.setSessions({ tokens: sessions.map((s) => s.token) }).catch(() => {});
        set({ sessions });
      },
    }, { auth, idleMs: st.idleMs });
    const h = host;
    handles = await Promise.all([
      BigScreen.addListener('request', (req) => {
        void h.handle(req).then((res) => BigScreen.respond({ id: req.id, ...res }));
      }),
      BigScreen.addListener('socketOpen', (e) => {
        void h.hello(e.session).then((msg) => BigScreen.send({ data: JSON.stringify(msg), sessions: [e.session] }));
      }),
    ]);
    const res = await BigScreen.start({ ports: BIGSCREEN_PORTS, deviceName, appVersion: APP_VERSION });
    await BigScreen.setAwake({ on: true });
    lastTouch = Date.now();
    noSessionSince = Date.now();
    timers = [
      // Abgelaufene Anmeldungen beenden; ohne Browser 30 min → von selbst aus.
      window.setInterval(() => {
        if (!host) return;
        const n = host.tick();
        if (n > 0) noSessionSince = Date.now();
        else if (Date.now() - noSessionSince > AUTO_OFF_MS) void stopBigScreen();
      }, 30_000),
      // Akku und Zustand an die Browser.
      window.setInterval(() => {
        if (host && st.sessions.length) void host.setIdle(st.idleMs);
      }, 60_000),
      // Ruhebild nach 2 min ohne Berührung (nicht im Scanner).
      window.setInterval(() => {
        if (!st.dimmed && !scannerActive && Date.now() - lastTouch > DIM_AFTER_MS) setDimmed(true);
      }, 10_000),
    ];
    window.addEventListener('pointerdown', onTouch, { passive: true });
    void BigScreen.battery().then((b) => set({ charging: !!b.charging })).catch(() => {});
    set({ running: true, busy: false, url: res.url });
  } catch (e) {
    await stopBigScreen();
    set({ busy: false, error: (e as Error).message || 'Big Screen ließ sich nicht starten.' });
  }
}

export async function stopBigScreen(): Promise<void> {
  for (const t of timers) window.clearInterval(t);
  timers = [];
  window.removeEventListener('pointerdown', onTouch);
  host?.stop();
  host = null;
  for (const h of handles) void h.remove();
  handles = [];
  await BigScreen.stop().catch(() => {});
  await BigScreen.setAwake({ on: false }).catch(() => {});
  set({ running: false, url: undefined, sessions: [], dimmed: false });
}

export function kickBigScreenSession(id: string): void {
  host?.kick(id);
}

/** Vom App-Rahmen: Scanner offen → kein Ruhebild. */
export function setScannerActive(active: boolean): void {
  scannerActive = active;
  if (active) onTouch();
}

function onTouch() {
  lastTouch = Date.now();
  if (st.dimmed) setDimmed(false);
}

function setDimmed(dimmed: boolean) {
  if (!st.running) return;
  void BigScreen.setAwake({ on: true, dim: dimmed }).catch(() => {});
  set({ dimmed });
}

/** Zwischenspeicher der Kartenbilder für den Browser (M20). */
export async function bigScreenImageCache(): Promise<{ bytes: number; count: number } | null> {
  if (!bigScreenAvailable()) return null;
  return BigScreen.imageCache().catch(() => null);
}

export async function clearBigScreenImageCache(): Promise<void> {
  if (bigScreenAvailable()) await BigScreen.clearImageCache();
}

/** Ruhebild antippen → wieder normal. */
export function wakeFromDim(): void {
  onTouch();
}

// --- Katalog für den Browser (M18) ---------------------------------------------------

/**
 * Bekommt der Browser denselben Katalog wie das Handy? Ja, wenn der aufgehobene Stand
 * (Katalog-Update) oder der eingebaute (APK) zur Datenbank passt. Sonst — z. B. nach einem
 * Katalog-Update mit einer älteren App-Version — muss er einmal bereitgestellt werden.
 */
export async function bigScreenCatalogReady(): Promise<{ ready: boolean; local?: string }> {
  const [local, live, embedded] = await Promise.all([
    getLocalCatalogVersion(),
    liveCatalogVersion(),
    fetchRemoteVersion(CATALOG_BASE_URL, 3000).then((v) => v?.catalogVersion),
  ]);
  return { ready: !!local && (live === local || (!live && embedded === local)), local };
}

/** Katalog-Dateien von GitHub holen und aufheben — mit Einspielen, falls dort ein neuerer liegt. */
export async function prepareBigScreenCatalog(onBytes?: (bytes: number) => void): Promise<'aufgehoben' | 'update'> {
  const [local, remote] = await Promise.all([getLocalCatalogVersion(), fetchRemoteVersion(REMOTE_CATALOG_BASE, 10000)]);
  if (!remote) throw new Error('Katalog auf GitHub nicht erreichbar.');
  if (!local || isNewerCatalog(remote.catalogVersion, local)) {
    void startCatalogUpdate({ kind: 'github' });
    return 'update';
  }
  try {
    await stageCatalog(REMOTE_CATALOG_BASE, onBytes);
    await promoteStagedCatalog();
  } catch (e) {
    await dropStagedCatalog();
    throw e;
  }
  return 'aufgehoben';
}
