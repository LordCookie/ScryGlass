import Dexie from 'dexie';
import { db, getMeta, setMeta } from '../db/db';
import type { Card, Printing, NameEntry, TrigramEntry } from '../domain/types';
import { NdjsonBuffer } from './ndjson';

/**
 * Katalog-Sync (PLAN.md § 4, M3). Beim App-Start:
 *   1. lokale catalogVersion lesen
 *   2. remote version.json holen (Timeout 3s) — Fehler/kein Netz = stiller Fallback
 *   3. lokal fehlt → Vollimport (Pflicht) · remote neuer → Hinweis (nicht erzwingen)
 *
 * Import: NDJSON zeilenweise streamen, `bulkPut` in 1500er-Chunks, zwischen Chunks
 * dem UI-Thread Luft geben. Abbruchsicher: `catalogVersion` wird ERST nach dem
 * letzten Chunk gesetzt — Abbruch mittendrin → nächster Start importiert neu.
 */

/**
 * Basis-URL des Katalogs. Dev/lokal: `/catalog` (der Vite-Dev-Server serviert
 * `app/public/catalog`). Produktion (APK): per `VITE_CATALOG_BASE_URL` auf das
 * GitHub-Release `catalog-latest` zeigen lassen, sobald das Repo öffentlich ist:
 *   https://github.com/LordCookie/ScryGlass/releases/download/catalog-latest
 */
export const CATALOG_BASE_URL: string =
  (import.meta.env?.VITE_CATALOG_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '/catalog';

const VERSION_KEY = 'catalogVersion';
const CHUNK = 1500;

export interface CatalogVersion {
  catalogVersion: string;
  builtAt: string;
  scryfallBulkDate: string;
  counts: { cards: number; printings: number; names: number; trigrams: number };
}

export type SyncPhase = 'cards' | 'printings' | 'names' | 'trigrams';

export interface SyncProgress {
  phase: SyncPhase;
  /** in dieser Phase geschriebene Records */
  phaseDone: number;
  /** erwartete Records dieser Phase (aus counts) */
  phaseTotal: number;
  /** insgesamt geschriebene Records über alle Phasen */
  overallDone: number;
  /** insgesamt erwartete Records */
  overallTotal: number;
}

export type SyncStatus = 'imported' | 'updated' | 'up-to-date' | 'update-available' | 'offline';

export interface SyncResult {
  status: SyncStatus;
  local?: string;
  remote?: CatalogVersion;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function fetchWithTimeout(url: string, ms: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Holt remote `version.json`. Gibt `null` bei Netzfehler/Timeout (§ 4: kein Dialog). */
export async function fetchRemoteVersion(
  base = CATALOG_BASE_URL,
  timeoutMs = 3000,
): Promise<CatalogVersion | null> {
  try {
    const res = await fetchWithTimeout(`${base}/version.json`, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as CatalogVersion;
  } catch {
    return null;
  }
}

export async function getLocalCatalogVersion(): Promise<string | undefined> {
  return getMeta<string>(VERSION_KEY);
}

/** Streamt ein NDJSON-File und schreibt es in Chunks in eine Dexie-Tabelle. */
async function importFile<T>(
  url: string,
  table: Dexie.Table<T, unknown>,
  phaseTotal: number,
  onChunk: (phaseDone: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`Katalog-Download fehlgeschlagen: ${url} (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buf = new NdjsonBuffer<T>();
  let pending: T[] = [];
  let done = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    await table.bulkPut(pending);
    done += pending.length;
    pending = [];
    await onChunk(done);
    await tick(); // UI bleibt bedienbar (§ 4)
  };

  for (;;) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    for (const row of buf.push(decoder.decode(value, { stream: true }))) {
      pending.push(row);
      if (pending.length >= CHUNK) await flush();
    }
  }
  for (const row of buf.flush()) pending.push(row);
  await flush();
  void phaseTotal; // nur für die Fortschrittsanzeige nach außen relevant
  return done;
}

/**
 * Vollimport/Update. Reihenfolge cards → printings → names → trigrams. Setzt
 * `catalogVersion` erst nach dem letzten Chunk (abbruchsicher). `owned`/`decks`/
 * `inbox` werden nie angefasst (§ 4).
 */
export async function importCatalog(
  remote: CatalogVersion,
  base = CATALOG_BASE_URL,
  onProgress?: (p: SyncProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const phases: { phase: SyncPhase; table: Dexie.Table<unknown, unknown>; total: number }[] = [
    { phase: 'cards', table: db.cards as unknown as Dexie.Table<unknown, unknown>, total: remote.counts.cards },
    { phase: 'printings', table: db.printings as unknown as Dexie.Table<unknown, unknown>, total: remote.counts.printings },
    { phase: 'names', table: db.names as unknown as Dexie.Table<unknown, unknown>, total: remote.counts.names },
    { phase: 'trigrams', table: db.trigrams as unknown as Dexie.Table<unknown, unknown>, total: remote.counts.trigrams },
  ];
  const overallTotal = phases.reduce((s, p) => s + p.total, 0);
  let overallBefore = 0;

  for (const { phase, table, total } of phases) {
    const before = overallBefore;
    await importFile(
      `${base}/${phase}.ndjson`,
      table,
      total,
      (phaseDone) =>
        onProgress?.({
          phase,
          phaseDone,
          phaseTotal: total,
          overallDone: before + phaseDone,
          overallTotal,
        }),
      signal,
    );
    overallBefore += total;
  }

  // ERST jetzt: der Import gilt als abgeschlossen (§ 4, abbruchsicher).
  await setMeta(VERSION_KEY, remote.catalogVersion);
}

/**
 * Start-Sync (§ 4). Importiert bei fehlendem lokalem Katalog zwingend (mit
 * Fortschritt); bei neuerer Remote-Version wird NICHT erzwungen, sondern
 * `update-available` gemeldet (dezenter Hinweis in der UI). Ohne Netz und mit
 * lokalem Katalog: `up-to-date` (App startet offline).
 */
export async function syncOnStartup(opts?: {
  base?: string;
  timeoutMs?: number;
  onProgress?: (p: SyncProgress) => void;
  signal?: AbortSignal;
}): Promise<SyncResult> {
  const base = opts?.base ?? CATALOG_BASE_URL;
  const local = await getLocalCatalogVersion();
  const remote = await fetchRemoteVersion(base, opts?.timeoutMs ?? 3000);

  if (!remote) {
    // Kein Netz / Fehler. Mit lokalem Katalog weiter, sonst offline & leer.
    return { status: local ? 'up-to-date' : 'offline', local };
  }
  if (!local) {
    await importCatalog(remote, base, opts?.onProgress, opts?.signal);
    return { status: 'imported', local: remote.catalogVersion, remote };
  }
  if (remote.catalogVersion !== local) {
    return { status: 'update-available', local, remote };
  }
  return { status: 'up-to-date', local, remote };
}

/** Vom Update-Hinweis ausgelöst: das Update wirklich einspielen. */
export async function applyUpdate(
  remote: CatalogVersion,
  opts?: { base?: string; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal },
): Promise<SyncResult> {
  await importCatalog(remote, opts?.base ?? CATALOG_BASE_URL, opts?.onProgress, opts?.signal);
  return { status: 'updated', local: remote.catalogVersion, remote };
}

/** Ist überhaupt ein Katalog geladen? (Startgate für Scanner/Suche.) */
export async function hasCatalog(): Promise<boolean> {
  return (await getLocalCatalogVersion()) != null && (await db.cards.count()) > 0;
}
