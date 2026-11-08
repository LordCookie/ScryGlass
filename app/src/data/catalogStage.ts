import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

/**
 * Katalog-Dateien am Handy aufheben (PLAN.md M18): Beim Katalog-Update lädt das Handy die
 * `.ndjson.gz` erst in einen Ordner und spielt sie von dort ein. Danach bleiben sie liegen,
 * damit der Big-Screen-Server dem Browser genau diesen Stand übers WLAN geben kann — ohne
 * Internet am PC. Die Bild-Hashes braucht nur der Scanner am Handy, die fliegen danach raus.
 *
 * Ordner (Directory.Data = filesDir, wie im nativen BigScreenPlugin):
 *   katalog/neu      während des Ladens
 *   katalog/aktuell  der eingespielte Stand
 */

const STAGE_DIR = 'katalog/neu';
const LIVE_DIR = 'katalog/aktuell';
const REQUIRED = ['version.json', 'cards.ndjson.gz', 'printings.ndjson.gz', 'names.ndjson.gz', 'hashes.ndjson.gz'];
const OPTIONAL = ['combos.ndjson.gz', 'precons.ndjson.gz'];

export function canStageCatalog(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Alle Katalog-Dateien von `remoteBase` nach katalog/neu laden. Gibt die Basis-URL zurück,
 * unter der die WebView sie lesen kann (wie eine Server-Adresse). Wirft bei Fehlern.
 */
export async function stageCatalog(remoteBase: string, onBytes?: (bytes: number) => void): Promise<string> {
  await Filesystem.rmdir({ path: STAGE_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
  // downloadFile legt den Ordner auf Android nicht selbst an (siehe App-Update).
  await Filesystem.mkdir({ path: STAGE_DIR, directory: Directory.Data, recursive: true });
  let doneBefore = 0;
  let current = 0;
  const listener = await Filesystem.addListener('progress', (p) => {
    current = p.bytes;
    onBytes?.(doneBefore + current);
  });
  try {
    for (const f of [...REQUIRED, ...OPTIONAL]) {
      current = 0;
      try {
        await Filesystem.downloadFile({ url: `${remoteBase}/${f}`, path: `${STAGE_DIR}/${f}`, directory: Directory.Data, progress: true });
      } catch (e) {
        if (REQUIRED.includes(f)) throw e;
        await Filesystem.deleteFile({ path: `${STAGE_DIR}/${f}`, directory: Directory.Data }).catch(() => {});
      }
      const st = await Filesystem.stat({ path: `${STAGE_DIR}/${f}`, directory: Directory.Data }).catch(() => null);
      doneBefore += st?.size ?? current;
      onBytes?.(doneBefore);
    }
  } finally {
    await listener.remove();
  }
  const { uri } = await Filesystem.getUri({ path: STAGE_DIR, directory: Directory.Data });
  return Capacitor.convertFileSrc(uri).replace(/\/$/, '');
}

/** Eingespielt: katalog/neu wird katalog/aktuell; die Bild-Hashes braucht der Browser nicht. */
export async function promoteStagedCatalog(): Promise<void> {
  await Filesystem.rmdir({ path: LIVE_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
  await Filesystem.rename({ from: STAGE_DIR, to: LIVE_DIR, directory: Directory.Data, toDirectory: Directory.Data });
  await Filesystem.deleteFile({ path: `${LIVE_DIR}/hashes.ndjson.gz`, directory: Directory.Data }).catch(() => {});
}

export async function dropStagedCatalog(): Promise<void> {
  await Filesystem.rmdir({ path: STAGE_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
}

/** Eingebauter Katalog eingespielt (nach App-Update): dann liefert der Server den aus der APK. */
export async function dropLiveCatalog(): Promise<void> {
  await Filesystem.rmdir({ path: LIVE_DIR, directory: Directory.Data, recursive: true }).catch(() => {});
}

/** Welcher Stand liegt aufgehoben bereit? (undefined = keiner) */
export async function liveCatalogVersion(): Promise<string | undefined> {
  if (!canStageCatalog()) return undefined;
  try {
    const r = await Filesystem.readFile({ path: `${LIVE_DIR}/version.json`, directory: Directory.Data, encoding: Encoding.UTF8 });
    return (JSON.parse(String(r.data)) as { catalogVersion?: string }).catalogVersion;
  } catch {
    return undefined;
  }
}
