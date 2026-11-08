import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { db, replaceOwned, saveDeck, getMeta, setMeta } from '../db/db';
import { serializeCollection, parseCollection, type CollectionExport } from '../domain/collectionIo';
import { backupFileName, parseBackupFileName, documentsBackupName, backupReminderDue } from '../domain/updates';
import { getTokenCount, setTokenCount } from './tokens';

/**
 * Sicherungen der Sammlung (Bestand, Decks, Tokens ohne Artwork).
 *
 * Automatisch vor jedem App-Update (M15) und Import still in den App-Speicher — übersteht
 * Updates, nur nicht das Deinstallieren. Die letzten drei bleiben; unter „Mehr → Backup"
 * lassen sie sich wiederherstellen oder teilen. Nur in der App (der Browser hat kein Dateisystem).
 *
 * Außerhalb der App (0.2.9): eine Kopie in Dokumente/ScryGlass bleibt auch beim Deinstallieren.
 * Ab Android 11 geht das ohne Erlaubnis (nur eigene Dateien); Android 10 braucht dafür
 * `requestLegacyExternalStorage`, ältere die Speicher-Erlaubnis (AndroidManifest).
 */

const DIR = 'sicherungen';
const KEEP = 3;
/** Ordner in „Dokumente" — in der Dateien-App sichtbar, übersteht das Deinstallieren. */
const DOCS_DIR = 'ScryGlass';
const DOCS_AUTO_DIR = `${DOCS_DIR}/Automatisch`;
const META_SAFE = 'lastSafeBackupAt';

export interface AutoBackup {
  name: string;
  at: number;
  reason: string;
}

async function currentBackupJson(at: number): Promise<{ json: string; owned: number; decks: number }> {
  const [owned, decks, tokens, precons] = await Promise.all([
    db.owned.toArray(), db.decks.toArray(), getTokenCount(), db.ownedPrecons.toArray(),
  ]);
  return { json: serializeCollection(owned, decks, at, tokens, precons), owned: owned.length, decks: decks.length };
}

/** Eine eingelesene Sicherung übernehmen (auch für „JSON importieren"). */
export async function applyBackup(parsed: CollectionExport): Promise<void> {
  await replaceOwned(parsed.owned);
  for (const d of parsed.decks) await saveDeck(d);
  if (parsed.tokens != null) await setTokenCount(parsed.tokens);
  // Übernommene Fertigdecks (M19) gehören zum Bestand — mit ihm ersetzt.
  await db.transaction('rw', db.ownedPrecons, async () => {
    await db.ownedPrecons.clear();
    if (parsed.precons?.length) await db.ownedPrecons.bulkAdd(parsed.precons.map(({ id: _id, ...p }) => p));
  });
}

// --- Außerhalb der App ------------------------------------------------------

/** Wann zuletzt außerhalb der App gesichert wurde (Dokumente-Ordner, geteilt, heruntergeladen). */
export function lastSafeBackup(): Promise<number | undefined> {
  return getMeta<number>(META_SAFE);
}

export async function markSafeBackup(at = Date.now()): Promise<void> {
  await setMeta(META_SAFE, at);
}

/** Punkt am „Mehr"-Tab: größere Sammlung, aber seit 30 Tagen nichts außerhalb der App gesichert. */
export async function backupReminder(): Promise<boolean> {
  const [last, rows] = await Promise.all([lastSafeBackup(), db.owned.count()]);
  return backupReminderDue(last, rows, Date.now());
}

/** Sicherung nach Dokumente/ScryGlass schreiben; gibt den angezeigten Pfad zurück. */
export async function saveBackupToDocuments(): Promise<{ path: string; owned: number; decks: number }> {
  // Android ≤ 10 fragt einmal nach dem Speicher; ab 11 meldet das Plugin sofort „granted".
  const perm = await Filesystem.requestPermissions();
  if (perm.publicStorage !== 'granted') throw new Error('Ohne Speicher-Erlaubnis geht das nicht — „Teilen" geht immer.');
  const at = Date.now();
  const name = documentsBackupName(at);
  const { json, owned, decks } = await currentBackupJson(at);
  await Filesystem.writeFile({
    path: `${DOCS_DIR}/${name}`,
    data: json,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  await markSafeBackup(at);
  return { path: `Dokumente/${DOCS_DIR}/${name}`, owned, decks };
}

/** Automatische Sicherung zusätzlich nach Dokumente/ScryGlass/Automatisch — nur wenn das
 *  ohne Nachfrage geht (Android 11+). Best-effort: scheitert es, bleibt die Kopie in der App. */
async function mirrorToDocuments(name: string, json: string, at: number): Promise<void> {
  if ((await Filesystem.checkPermissions()).publicStorage !== 'granted') return;
  await Filesystem.writeFile({
    path: `${DOCS_AUTO_DIR}/${name}`,
    data: json,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  await markSafeBackup(at);
  // Aufräumen: nur eigene Dateien sind sichtbar (Android 11+) — fremde bleiben unberührt.
  const { files } = await Filesystem.readdir({ path: DOCS_AUTO_DIR, directory: Directory.Documents });
  const old = files
    .map((f) => parseBackupFileName(f.name))
    .filter((b): b is AutoBackup => b != null)
    .sort((a, b) => b.at - a.at)
    .slice(KEEP);
  for (const b of old) {
    await Filesystem.deleteFile({ path: `${DOCS_AUTO_DIR}/${b.name}`, directory: Directory.Documents }).catch(() => {});
  }
}

// --- Automatische Sicherungen im App-Speicher -------------------------------

export async function listAutoBackups(): Promise<AutoBackup[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
    return files
      .map((f) => parseBackupFileName(f.name))
      .filter((b): b is AutoBackup => b != null)
      .sort((a, b) => b.at - a.at);
  } catch {
    return []; // noch keine Sicherung
  }
}

/** Jetzt sichern; gibt die Sicherung zurück (im Browser: null). */
export async function autoBackup(reason: string): Promise<AutoBackup | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const at = Date.now();
  const name = backupFileName(at, reason);
  const { json } = await currentBackupJson(at);
  await Filesystem.writeFile({
    path: `${DIR}/${name}`,
    data: json,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  for (const old of (await listAutoBackups()).slice(KEEP)) {
    await Filesystem.deleteFile({ path: `${DIR}/${old.name}`, directory: Directory.Data }).catch(() => {});
  }
  await mirrorToDocuments(name, json, at).catch(() => {});
  return parseBackupFileName(name);
}

/** Sicherung zurückspielen. Erst einlesen, dann den jetzigen Stand sichern (dabei kann die
 *  älteste Sicherung wegfallen — die gewählte ist da schon gelesen), dann übernehmen. */
export async function restoreAutoBackup(name: string): Promise<CollectionExport> {
  const file = await Filesystem.readFile({ path: `${DIR}/${name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
  const parsed = parseCollection(typeof file.data === 'string' ? file.data : await file.data.text());
  await autoBackup('vor-wiederherstellen');
  await applyBackup(parsed);
  return parsed;
}

/** Sicherung über das Teilen-Menü weitergeben (z. B. in Drive oder an sich selbst). Geteilt
 *  werden kann nur aus dem Cache (FileProvider, res/xml/file_paths.xml) — also erst kopieren. */
export async function shareAutoBackup(name: string): Promise<void> {
  const { uri } = await Filesystem.copy({ from: `${DIR}/${name}`, directory: Directory.Data, to: name, toDirectory: Directory.Cache });
  await Share.share({ title: name, url: uri });
  await markSafeBackup();
}
