import { db } from '../db/db';
import {
  NameIndex,
  matchName,
  normalizeName,
  trigramsOf,
  type MatchResult,
} from '../domain/nameMatch';

/**
 * Verdrahtet den puren Matcher (§ 5) mit Dexie (PLAN.md E3):
 *   - Der Namensindex wird beim ersten Bedarf EINMAL aus `names` in den RAM geladen
 *     und bleibt liegen. Exakt-/Präfix-Treffer fassen die DB nie an.
 *   - Nur bei einem Miss werden die Trigramm-Postings für die OCR-Trigramme aus
 *     Dexie geholt (der einzige DB-Zugriff pro Scan-Miss).
 */

let indexPromise: Promise<NameIndex> | null = null;

/** Lädt (und cached) den In-Memory-Namensindex. `force` baut ihn nach einem
 *  Katalog-Update neu auf. */
export async function loadNameIndex(force = false): Promise<NameIndex> {
  if (force) indexPromise = null;
  if (!indexPromise) {
    indexPromise = (async () => {
      const names = await db.names.toArray();
      return new NameIndex(names);
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
 * Gleicht einen OCR-Text gegen den Katalog ab (§ 5). Exakt/Präfix laufen rein im
 * RAM; nur bei Miss werden Trigramm-Postings nachgeladen und der Fuzzy-Fallback
 * gefahren.
 */
export async function matchOcr(ocrText: string, opts: MatchOptions = {}): Promise<MatchResult> {
  const index = await loadNameIndex();

  // Schritt 1+2 (Exakt/Präfix) — null DB-Zugriffe.
  const quick = matchName(ocrText, index, null, opts);
  if (quick.best) return quick;

  // Schritt 3 (Fuzzy) — jetzt (und nur jetzt) den Trigramm-Index anfassen.
  const norm = normalizeName(ocrText);
  const tris = [...new Set(trigramsOf(norm))];
  if (tris.length === 0) return quick;
  const rows = await db.trigrams.bulkGet(tris);
  const postings = new Map<string, string[]>();
  rows.forEach((row, i) => {
    if (row) postings.set(tris[i], row.oracleIds);
  });
  return matchName(ocrText, index, postings, opts);
}
