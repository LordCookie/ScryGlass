import { Capacitor } from '@capacitor/core';
import { syncDailyCheck } from './dailyCheck';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { getMeta, setMeta, db } from '../db/db';
import { APP_VERSION } from '../version';
import {
  pickLatestAppRelease, parseSha256, isNewerVersion, isNewerCatalog, updateCheckDue,
  type AppRelease, type GhRelease, type GhAsset,
} from '../domain/updates';
import {
  fetchRemoteVersion, getLocalCatalogVersion, applyUpdate, CATALOG_BASE_URL,
  type CatalogVersion, type SyncProgress,
} from './catalog';
import { syncHashes, loadHashIndex } from './imageHash';
import { syncCombos } from './combos';
import { syncPrecons } from './precons';
import { canStageCatalog, stageCatalog, promoteStagedCatalog, dropStagedCatalog, dropLiveCatalog } from './catalogStage';
import { invalidateNameIndex } from './matcher';
import { invalidateSearchIndex } from './search';
import { AppUpdater, hasAppUpdater, withScreenOn } from '../native/appUpdater';
import { autoBackup, listAutoBackups } from './backups';
import { Job } from './job';

/**
 * Updates aus der App (PLAN.md M15) über die öffentlichen GitHub-Releases:
 *   • App: höchstes `vX.Y.Z` mit APK (domain/updates) → sichern → laden → prüfen → Installer
 *   • Katalog: der wöchentlich gebaute `catalog-latest`, gzip-komprimiert
 *
 * Netz: Die GitHub-API erlaubt Browser-Anfragen (CORS), die Release-Downloads nicht. In der
 * App laufen GET-Anfragen ohnehin über den nativen HTTP-Weg von Capacitor (CapacitorHttp,
 * capacitor.config) — dort gibt es kein CORS, und der Katalog streamt wie bisher. Im Browser
 * geht deshalb nur die Versions-Abfrage; laden kann nur die App.
 */

export const REPO = 'LordCookie/ScryGlass';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const API = `https://api.github.com/repos/${REPO}`;
/** Wöchentlich gebauter Katalog (.github/workflows/catalog.yml, hashes.yml). */
export const REMOTE_CATALOG_BASE = `https://github.com/${REPO}/releases/download/catalog-latest`;
// Was die App lädt — `trigrams.ndjson` liegt noch daneben (für 0.2.6), wird aber nicht mehr gebraucht.
const CATALOG_FILES = ['cards', 'printings', 'names', 'hashes'].map((f) => `${f}.ndjson`);

/** Nur die App kann Katalog und APK laden (Browser: CORS). */
export function canDownloadUpdates(): boolean {
  return Capacitor.isNativePlatform();
}

async function getJson<T>(url: string, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchLatestAppRelease(): Promise<AppRelease | null> {
  return pickLatestAppRelease(await getJson<GhRelease[]>(`${API}/releases?per_page=30`));
}

export interface RemoteCatalogInfo {
  version: string;
  /** Liegen die Dateien komprimiert vor (`*.ndjson.gz`)? Sonst die unkomprimierten. */
  gzip: boolean;
  /** Download-Größe aller Dateien */
  bytes: number;
}

/** Was liegt in `catalog-latest`? Version aus version.json, Größen aus der API. */
export async function fetchRemoteCatalogInfo(): Promise<RemoteCatalogInfo | null> {
  if (!canDownloadUpdates()) return null;
  const [rel, version] = await Promise.all([
    getJson<{ assets: GhAsset[] }>(`${API}/releases/tags/catalog-latest`),
    fetchRemoteVersion(REMOTE_CATALOG_BASE, 10000),
  ]);
  if (!version) return null;
  const size = new Map(rel.assets.map((a) => [a.name, a.size]));
  const gzip = CATALOG_FILES.every((f) => size.has(`${f}.gz`));
  const bytes = CATALOG_FILES.reduce((s, f) => s + (size.get(gzip ? `${f}.gz` : f) ?? 0), 0);
  return { version: version.catalogVersion, gzip, bytes };
}

// --- Täglicher Blick nach Neuem (Punkt am „Mehr"-Tab) --------------------------

export interface UpdateStatus {
  checkedAt: number;
  /** nur gesetzt, wenn neuer als die installierte App */
  app?: AppRelease;
  /** nur gesetzt, wenn neuer als der lokale Katalog */
  catalog?: RemoteCatalogInfo;
}

const STATUS_KEY = 'updateStatus';

/** Gemerkter Stand, gefiltert gegen das, was jetzt installiert ist (nach einem Update ist
 *  der Punkt sofort weg). Live-fähig (liest nur Dexie). */
export async function currentUpdateStatus(): Promise<UpdateStatus | undefined> {
  const [s, local] = await Promise.all([getMeta<UpdateStatus>(STATUS_KEY), getLocalCatalogVersion()]);
  if (!s) return undefined;
  return {
    checkedAt: s.checkedAt,
    app: s.app && isNewerVersion(s.app.version, APP_VERSION) ? s.app : undefined,
    catalog: s.catalog && isNewerCatalog(s.catalog.version, local) ? s.catalog : undefined,
  };
}

/** Bei GitHub nachsehen — automatisch höchstens einmal am Tag, `force` sofort.
 *  Ohne Netz bleibt der alte Stand (und der nächste Start versucht es wieder). */
export async function checkForUpdates(force = false): Promise<UpdateStatus | undefined> {
  const prev = await getMeta<UpdateStatus>(STATUS_KEY);
  if (!force && prev && !updateCheckDue(prev.checkedAt, Date.now())) return currentUpdateStatus();
  const [app, catalog] = await Promise.all([
    fetchLatestAppRelease().then((r) => ({ ok: true as const, r }), () => ({ ok: false as const, r: null })),
    fetchRemoteCatalogInfo().then((r) => ({ ok: true as const, r }), () => ({ ok: false as const, r: null })),
  ]);
  // Offline: weder App- noch Katalog-Abfrage kam durch (im Browser gibt es nur die erste).
  if (!app.ok && (!catalog.ok || !canDownloadUpdates())) {
    if (force) throw new Error('GitHub nicht erreichbar — Internet an?');
    return currentUpdateStatus();
  }
  // Was gelungen ist, ersetzt den alten Stand (auch „nichts Neues"); Fehlgeschlagenes bleibt.
  await setMeta(STATUS_KEY, {
    checkedAt: Date.now(),
    app: app.ok ? (app.r ?? undefined) : prev?.app,
    catalog: catalog.ok ? (catalog.r ?? undefined) : prev?.catalog,
  } satisfies UpdateStatus);
  return currentUpdateStatus();
}

// --- App-Update ---------------------------------------------------------------

export type InstallStep =
  | { phase: 'sicherung' }
  | { phase: 'download'; done: number; total: number }
  | { phase: 'pruefen' };

export class UpdateError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const INSTALL_ERRORS: Record<string, string> = {
  ERLAUBNIS: 'ScryGlass darf noch keine Updates installieren — einmal erlauben, dann nochmal.',
  PRUEFSUMME: 'Die geladene Datei ist beschädigt (Prüfsumme stimmt nicht). Bitte nochmal laden.',
  SIGNATUR: 'Die APK ist anders signiert als deine App — Installation abgebrochen.',
  NICHT_NEUER: 'Diese Version ist schon installiert.',
  PAKET: 'Das ist keine ScryGlass-APK.',
  APK: 'Die Datei ist keine gültige APK.',
  ALT: 'Auf diesem Android-Stand geht das nur von Hand (Release-Seite).',
};

const UPDATE_DIR = 'update';
const WHATS_NEW_KEY = 'whatsNew';
/** So lange gilt ein neuer Anlauf für dieselbe Version als „nochmal versucht". */
const RETRY_WINDOW_MS = 3600_000;

/**
 * Sichern → Prüfsumme holen → APK laden → nativ prüfen → Installer öffnen. Den Rest
 * (bestätigen, neu starten) macht Android. Die Patch Notes werden gemerkt und nach dem
 * Neustart einmal als „Was ist neu" gezeigt.
 */
export async function downloadAndInstall(rel: AppRelease, onStep: (s: InstallStep) => void): Promise<void> {
  if (!hasAppUpdater()) throw new UpdateError('Nur in der Android-App.', 'ALT');
  // Erlaubnis zuerst — sonst wären 60 MB umsonst geladen.
  const perm = await AppUpdater.canInstall();
  if (!perm.supported) throw new UpdateError(INSTALL_ERRORS.ALT, 'ALT');
  if (!perm.allowed) throw new UpdateError(INSTALL_ERRORS.ERLAUBNIS, 'ERLAUBNIS');

  onStep({ phase: 'sicherung' });
  // Zweiter Versuch kurz danach (Installer abgebrochen, Play-Protect-Hinweis …): nicht nochmal
  // sichern — sonst verdrängen Kopien desselben Stands die älteren Sicherungen (es bleiben drei).
  const last = (await listAutoBackups())[0];
  if (!(last && last.reason === `vor-${rel.version}` && Date.now() - last.at < RETRY_WINDOW_MS)) {
    await autoBackup(`vor-${rel.version}`);
  }
  await setMeta(WHATS_NEW_KEY, { version: rel.version, notes: rel.notes });

  // Ohne Prüfsumme keine Installation (jedes Release ab M15 hat eine `.sha256`).
  if (!rel.sha256Url) throw new UpdateError('Dem Release fehlt die Prüfsumme — bitte von Hand laden.', 'PRUEFSUMME');
  const shaRes = await fetch(rel.sha256Url);
  const sha256 = shaRes.ok ? parseSha256(await shaRes.text()) : null;
  if (!sha256) throw new UpdateError('Prüfsumme nicht lesbar — bitte später nochmal.', 'PRUEFSUMME');

  // Schon geladen? Dann nicht nochmal 40 MB laden. Ob die Datei stimmt, prüft das native
  // Plugin über die Prüfsumme — passt sie nicht, löscht es die Datei und es wird neu geladen.
  const target = `${UPDATE_DIR}/${rel.apk.name}`;
  const cached = await Filesystem.stat({ path: target, directory: Directory.Cache }).catch(() => null);
  if (cached && cached.type === 'file' && (!rel.apk.size || cached.size === rel.apk.size)) {
    onStep({ phase: 'pruefen' });
    try {
      await AppUpdater.install({ path: cached.uri, sha256 });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'FEHLER';
      if (code !== 'PRUEFSUMME' && code !== 'PFAD') {
        throw new UpdateError(INSTALL_ERRORS[code] ?? `Installation fehlgeschlagen (${(e as Error).message}).`, code);
      }
    }
  }

  await Filesystem.rmdir({ path: UPDATE_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
  // downloadFile legt auf Android den Ordner NICHT an (`recursive` wird in
  // @capacitor/filesystem 6.0.4 ignoriert) — ohne das scheitert jeder Download (0.2.6/0.2.7).
  await Filesystem.mkdir({ path: UPDATE_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
  onStep({ phase: 'download', done: 0, total: rel.apk.size });
  const listener = await Filesystem.addListener('progress', (p) =>
    onStep({ phase: 'download', done: p.bytes, total: p.contentLength || rel.apk.size }),
  );
  let path: string | undefined;
  try {
    path = (await Filesystem.downloadFile({
      url: rel.apk.url,
      path: target,
      directory: Directory.Cache,
      recursive: true,
      progress: true,
    })).path;
  } catch (e) {
    // Den nativen Grund mit anzeigen — „Internet prüfen" allein hat den Ordner-Fehler verdeckt.
    const detail = (e as Error)?.message?.replace(/^Error downloading file:\s*/, '');
    throw new UpdateError(`Download abgebrochen — Internet prüfen und nochmal.${detail ? ` (${detail})` : ''}`, 'DOWNLOAD');
  } finally {
    await listener.remove();
  }
  if (!path) throw new UpdateError('Download ohne Datei.', 'FEHLER');

  onStep({ phase: 'pruefen' });
  try {
    await AppUpdater.install({ path, sha256 });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'FEHLER';
    throw new UpdateError(INSTALL_ERRORS[code] ?? `Installation fehlgeschlagen (${(e as Error).message}).`, code);
  }
}

/** Läuft im Hintergrund weiter, auch beim Tab-Wechsel (data/job). Ergebnis `installer`:
 *  Android zeigt jetzt den Installations-Dialog. */
export const appUpdateJob = new Job<InstallStep, 'installer'>();

export function startAppUpdate(rel: AppRelease): Promise<void> {
  return appUpdateJob.run(async (onStep) => {
    await withScreenOn(() => downloadAndInstall(rel, onStep));
    return 'installer' as const;
  });
}

export async function openInstallSettings(): Promise<void> {
  await AppUpdater.openInstallSettings();
}

/** Nach einem Update einmal „Was ist neu" zeigen: Notes, wenn die neue Version läuft. */
export async function pendingWhatsNew(): Promise<{ version: string; notes: string } | null> {
  const w = await getMeta<{ version: string; notes: string }>(WHATS_NEW_KEY);
  return w && w.version === APP_VERSION ? w : null;
}

/** „Was ist neu" gesehen: Notiz und geladene APK aufräumen. */
export async function dismissWhatsNew(): Promise<void> {
  await db.meta.delete(WHATS_NEW_KEY);
  if (canDownloadUpdates()) await Filesystem.rmdir({ path: UPDATE_DIR, directory: Directory.Cache, recursive: true }).catch(() => {});
}

// --- Katalog-Update -------------------------------------------------------------

export type CatalogStep =
  /** Dateien aufs Handy laden (für Big Screen aufgehoben, M18) */
  | { phase: 'laden'; bytes: number; total: number }
  | { phase: 'katalog'; progress: SyncProgress }
  /** `total` geschätzt: ein Bild-Hash je Druckausgabe */
  | { phase: 'bilder'; done: number; total: number }
  | { phase: 'kombos'; done: number; total: number }
  | { phase: 'fertigdecks'; done: number; total: number };

/** Woher: der wöchentliche von GitHub oder der in die APK eingebaute (nach einem App-Update
 *  mit neuerem Katalog; im Browser beim Entwickeln der einzige). */
export type CatalogSource = { kind: 'github' } | { kind: 'eingebaut'; version: CatalogVersion };

/** Katalog einspielen, danach den Bild-Abgleich. Sammlung, Decks und Tokens-Zähler
 *  bleiben unberührt (§ 4). Gibt die neue Katalogversion zurück. */
async function applyCatalog(source: CatalogSource, onStep: (s: CatalogStep) => void): Promise<string> {
  let base = CATALOG_BASE_URL;
  let gzip = false;
  let version: CatalogVersion;
  let staged = false;
  if (source.kind === 'github') {
    const [info, remote] = await Promise.all([fetchRemoteCatalogInfo(), fetchRemoteVersion(REMOTE_CATALOG_BASE, 10000)]);
    if (!info || !remote) throw new Error('Katalog auf GitHub nicht erreichbar.');
    base = REMOTE_CATALOG_BASE;
    gzip = info.gzip;
    version = remote;
    // Erst aufs Handy laden, dann von dort einspielen — die Dateien bleiben für den Big Screen
    // liegen (M18). Klappt das nicht, wie früher direkt von GitHub.
    if (gzip && canStageCatalog()) {
      try {
        const total = info.bytes + 2_000_000; // + Kombos/Fertigdecks (ungefähr)
        onStep({ phase: 'laden', bytes: 0, total });
        base = await stageCatalog(REMOTE_CATALOG_BASE, (bytes) => onStep({ phase: 'laden', bytes, total }));
        staged = true;
      } catch {
        await dropStagedCatalog();
        base = REMOTE_CATALOG_BASE;
      }
    }
  } else {
    version = source.version;
  }
  await applyUpdate(version, { base, gzip, onProgress: (progress) => onStep({ phase: 'katalog', progress }) });
  invalidateNameIndex();
  invalidateSearchIndex();
  const total = version.counts.printings;
  await syncHashes(base, version.catalogVersion, (done) => onStep({ phase: 'bilder', done, total }), gzip);
  void loadHashIndex();
  const combos = version.counts.combos ?? 100_000;
  await syncCombos(base, version.catalogVersion, (done) => onStep({ phase: 'kombos', done, total: combos }), gzip);
  const precons = version.counts.precons ?? 2_500;
  await syncPrecons(base, version.catalogVersion, (done) => onStep({ phase: 'fertigdecks', done, total: precons }), gzip);
  // Big Screen (M18): der aufgehobene Stand passt jetzt zur Datenbank. Beim eingebauten
  // Katalog liefert der Server die Dateien aus der APK — ein alter aufgehobener Stand muss weg.
  if (staged) await promoteStagedCatalog().catch(() => {});
  else if (source.kind === 'eingebaut') await dropLiveCatalog();
  // Täglicher Update-Blick (M23) vergleicht ab jetzt mit dem neuen Stand.
  void syncDailyCheck().catch(() => {});
  return version.catalogVersion;
}

/** Läuft im Hintergrund weiter, auch beim Tab-Wechsel (data/job); Ergebnis = neue Version. */
export const catalogJob = new Job<CatalogStep, string>();

export function startCatalogUpdate(source: CatalogSource): Promise<void> {
  return catalogJob.run((onStep) => withScreenOn(() => applyCatalog(source, onStep)));
}
