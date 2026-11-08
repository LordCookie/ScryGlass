import { db, getMeta, setMeta } from '../db/db';
import { streamImport } from './bulkImport';
import { isNewerCatalog } from '../domain/updates';

/**
 * Katalog-Sync (PLAN.md § 4, M3). Beim App-Start:
 *   1. lokale catalogVersion lesen
 *   2. remote version.json holen (Timeout 3s) — Fehler/kein Netz = stiller Fallback
 *   3. lokal fehlt → Vollimport (Pflicht) · remote neuer → Hinweis (nicht erzwingen)
 *
 * Import: NDJSON zeilenweise streamen, in 1500er-Chunks schreiben, beim Update nur
 * Neues und Geändertes (data/bulkImport). Abbruchsicher: `catalogVersion` wird ERST
 * nach dem letzten Chunk gesetzt — Abbruch mittendrin → nächster Start importiert neu.
 *
 * Quellen: der in die APK eingebaute Katalog (`/catalog`) und — seit M15 — der wöchentlich
 * gebaute auf GitHub (`data/updates.ts`), dort gzip-komprimiert (110 → 45 MB).
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

export interface CatalogVersion {
  catalogVersion: string;
  builtAt: string;
  scryfallBulkDate: string;
  counts: { cards: number; printings: number; names: number; trigrams: number; combos?: number };
}

export type SyncPhase = 'cards' | 'printings' | 'names';

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

/**
 * Vollimport/Update. Reihenfolge cards → printings → names (data/bulkImport: beim Update
 * nur Neues und Geändertes). Setzt `catalogVersion` erst nach dem letzten Chunk
 * (abbruchsicher). `owned`/`decks`/`inbox` werden nie angefasst (§ 4). `gzip`: Dateien
 * als `*.ndjson.gz` (GitHub).
 *
 * `trigrams.ndjson` liegt weiter im Katalog (0.2.6 lädt es noch), wird aber seit 0.2.7
 * nicht mehr importiert — der Namensindex baut die Trigramme selbst (domain/nameMatch).
 * Das war über die Hälfte des Downloads.
 */
export async function importCatalog(
  remote: CatalogVersion,
  base = CATALOG_BASE_URL,
  onProgress?: (p: SyncProgress) => void,
  signal?: AbortSignal,
  gzip = false,
): Promise<void> {
  const file = (name: SyncPhase) => `${base}/${name}.ndjson${gzip ? '.gz' : ''}`;
  const phases: { phase: SyncPhase; total: number; run: (onChunk: (done: number) => void) => Promise<unknown> }[] = [
    {
      phase: 'cards',
      total: remote.counts.cards,
      run: (onChunk) => streamImport(file('cards'), db.cards, { gzip, signal, onChunk, key: (c) => c.oracleId, diff: 'rows' }),
    },
    {
      phase: 'printings',
      total: remote.counts.printings,
      run: (onChunk) => streamImport(file('printings'), db.printings, { gzip, signal, onChunk, key: (p) => p.scryfallId, diff: 'rows' }),
    },
    {
      phase: 'names',
      total: remote.counts.names,
      run: (onChunk) =>
        streamImport(file('names'), db.names, {
          gzip, signal, onChunk, diff: 'keys',
          key: (n) => [n.normName, n.oracleId, n.lang] as [string, string, string],
        }),
    },
  ];
  const overallTotal = phases.reduce((s, p) => s + p.total, 0);
  let overallBefore = 0;

  for (const { phase, total, run } of phases) {
    const before = overallBefore;
    await run((phaseDone) =>
      onProgress?.({ phase, phaseDone, phaseTotal: total, overallDone: before + phaseDone, overallTotal }),
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
 * lokalem Katalog: `up-to-date` (App startet offline). Nur NEUER zählt — ein von
 * GitHub geladener Katalog ist oft jünger als der in die APK eingebaute.
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
  if (isNewerCatalog(remote.catalogVersion, local)) {
    return { status: 'update-available', local, remote };
  }
  return { status: 'up-to-date', local, remote };
}

/** Vom Update-Hinweis ausgelöst: das Update wirklich einspielen. */
export async function applyUpdate(
  remote: CatalogVersion,
  opts?: { base?: string; onProgress?: (p: SyncProgress) => void; signal?: AbortSignal; gzip?: boolean },
): Promise<SyncResult> {
  await importCatalog(remote, opts?.base ?? CATALOG_BASE_URL, opts?.onProgress, opts?.signal, opts?.gzip);
  return { status: 'updated', local: remote.catalogVersion, remote };
}

/** Ist überhaupt ein Katalog geladen? (Startgate für Scanner/Suche.) */
export async function hasCatalog(): Promise<boolean> {
  return (await getLocalCatalogVersion()) != null && (await db.cards.count()) > 0;
}
