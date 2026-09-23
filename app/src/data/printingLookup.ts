import { db } from '../db/db';
import type { Printing } from '../domain/types';

/**
 * Ausgaben-Suche für den Scanner: Set-Code + Sammlernummer (Druckinfo unten links)
 * → exakte Druckausgabe über den Index [set+collectorNumber]. Und die Mitglieder
 * eines Sets für den Set-Modus.
 */

/** Exakte Ausgabe per Set + Nummer; bevorzugt die gelesene Sprache, sonst EN. */
export async function findPrinting(set: string, number: string, lang?: string): Promise<Printing | undefined> {
  const s = set.toLowerCase();
  const n = number.toLowerCase();
  // Katalog speichert Nummern ohne führende Nullen; zur Sicherheit beide Formen.
  const variants = [...new Set([n, n.replace(/^0+(?=\d)/, '')])];
  for (const v of variants) {
    const rows = await db.printings.where('[set+collectorNumber]').equals([s, v]).toArray();
    if (rows.length) return rows.find((p) => p.lang === lang) ?? rows.find((p) => p.lang === 'en') ?? rows[0];
  }
  return undefined;
}

export interface SetMembers {
  code: string;
  oracleIds: Set<string>;
  scryfallIds: Set<string>;
}

/** Alle Ausgaben eines Sets (für den Set-Modus). */
export async function setMembers(code: string): Promise<SetMembers> {
  const rows = await db.printings.where('set').equals(code.toLowerCase()).toArray();
  return {
    code: code.toLowerCase(),
    oracleIds: new Set(rows.map((p) => p.oracleId)),
    scryfallIds: new Set(rows.map((p) => p.scryfallId)),
  };
}

/** Alle Set-Codes im Katalog (für die Auswahl), schnell über den Index. */
export async function catalogSetCodes(): Promise<string[]> {
  return (await db.printings.orderBy('set').uniqueKeys()) as string[];
}
