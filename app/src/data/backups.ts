import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { db, replaceOwned, saveDeck } from '../db/db';
import { serializeCollection, parseCollection, type CollectionExport } from '../domain/collectionIo';
import { backupFileName, parseBackupFileName } from '../domain/updates';
import { getTokenCount, setTokenCount } from './tokens';

/**
 * Sicherungen der Sammlung (Bestand, Decks, Tokens ohne Artwork).
 *
 * Automatisch vor jedem App-Update (M15) still in den App-Speicher — übersteht Updates,
 * nur nicht das Deinstallieren. Die letzten drei bleiben; unter „Mehr → Backup" lassen sie
 * sich wiederherstellen oder teilen. Nur in der App (der Browser hat kein Dateisystem).
 */

const DIR = 'sicherungen';
const KEEP = 3;

export interface AutoBackup {
  name: string;
  at: number;
  reason: string;
}

/** Eine eingelesene Sicherung übernehmen (auch für „JSON importieren"). */
export async function applyBackup(parsed: CollectionExport): Promise<void> {
  await replaceOwned(parsed.owned);
  for (const d of parsed.decks) await saveDeck(d);
  if (parsed.tokens != null) await setTokenCount(parsed.tokens);
}

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
  const [owned, decks, tokens] = await Promise.all([db.owned.toArray(), db.decks.toArray(), getTokenCount()]);
  const at = Date.now();
  const name = backupFileName(at, reason);
  await Filesystem.writeFile({
    path: `${DIR}/${name}`,
    data: serializeCollection(owned, decks, at, tokens),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  for (const old of (await listAutoBackups()).slice(KEEP)) {
    await Filesystem.deleteFile({ path: `${DIR}/${old.name}`, directory: Directory.Data }).catch(() => {});
  }
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
}
