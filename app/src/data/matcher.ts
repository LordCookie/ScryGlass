import { db } from '../db/db';
import { NameIndex, matchName, type MatchResult } from '../domain/nameMatch';

/**
 * Verdrahtet den puren Matcher (§ 5) mit Dexie (PLAN.md E3):
 *   - Der Namensindex wird beim ersten Bedarf EINMAL aus `names` in den RAM geladen
 *     und bleibt liegen. Danach fasst kein Scan die DB mehr an.
 *   - Die Trigramm-Postings für den Fuzzy-Fallback baut der Index beim ersten Miss
 *     selbst aus den Namen (früher eigene Dexie-Tabelle `trigrams`, seit 0.2.7 nicht
 *     mehr importiert).
 */

let indexPromise: Promise<NameIndex> | null = null;

/** Lädt (und cached) den In-Memory-Namensindex. `force` baut ihn nach einem
 *  Katalog-Update neu auf. */
export async function loadNameIndex(force = false): Promise<NameIndex> {
  if (force) indexPromise = null;
  if (!indexPromise) {
    indexPromise = (async () => {
      const names = await db.names.toArray();
      const index = new NameIndex(names);
      // Postings gleich hinterher bauen (~0,3 s Desktop), damit der erste Verleser beim
      // Scannen nicht darauf wartet.
      setTimeout(() => index.trigramPostings(), 1000);
      return index;
    })();
  }
  return indexPromise;
}

/** Nach einem Katalog-Import den Index verwerfen, damit er frisch geladen wird. */
export function invalidateNameIndex(): void {
  indexPromise = null;
}

export interface MatchOptions {
  threshold?: number;
  topN?: number;
}

/**
 * Gleicht einen OCR-Text gegen den Katalog ab (§ 5) — komplett im RAM. Die
 * Trigramm-Postings entstehen erst beim ersten Miss (Exakt/Präfix brauchen sie nicht).
 */
export async function matchOcr(ocrText: string, opts: MatchOptions = {}): Promise<MatchResult> {
  const index = await loadNameIndex();

  // Schritt 1+2 (Exakt/Präfix).
  const quick = matchName(ocrText, index, null, opts);
  if (quick.best) return quick;

  // Schritt 3 (Fuzzy).
  return matchName(ocrText, index, index.trigramPostings(), opts);
}
