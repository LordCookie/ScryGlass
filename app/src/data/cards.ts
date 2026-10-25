import { db } from '../db/db';
import type { Card, Printing, Lang } from '../domain/types';

/**
 * Karten-/Printing-Lookups gegen Dexie (für Anzeige/Deckbau). Der Scanner nutzt
 * das NICHT pro Frame (E3) — hier geht es um Detail-/Listenansichten nach einem Treffer.
 */

export async function getCard(oracleId: string): Promise<Card | undefined> {
  return db.cards.get(oracleId);
}

/** Mehrere Karten auf einmal (Deckliste, Suchergebnisse). */
export async function getCards(oracleIds: readonly string[]): Promise<Map<string, Card>> {
  const uniq = [...new Set(oracleIds)];
  const rows = await db.cards.bulkGet(uniq);
  const map = new Map<string, Card>();
  rows.forEach((c) => {
    if (c) map.set(c.oracleId, c);
  });
  return map;
}

/**
 * Eine Druckausgabe zum Anzeigen wählen (fürs Bild). Bevorzugt die gewünschte
 * Sprache, sonst irgendeine. v1 hat kein „bevorzugtes Printing" — die erste reicht
 * fürs Bild (PLAN.md § 3).
 */
export async function previewPrinting(
  oracleId: string,
  lang?: Lang,
): Promise<Printing | undefined> {
  const printings = await db.printings.where('oracleId').equals(oracleId).toArray();
  if (printings.length === 0) return undefined;
  if (lang) {
    const match = printings.find((p) => p.lang === lang);
    if (match) return match;
  }
  const en = printings.find((p) => p.lang === 'en');
  return en ?? printings[0];
}

/** scryfallId je oracleId (fürs Bild), bevorzugt englische Ausgabe. Ein Query. */
export async function previewImageIds(
  oracleIds: readonly string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(oracleIds)];
  if (uniq.length === 0) return new Map();
  const rows = await db.printings.where('oracleId').anyOf(uniq).toArray();
  const out = new Map<string, string>();
  for (const p of rows) {
    const cur = out.get(p.oracleId);
    // Erste gefundene nehmen; englische bevorzugen (überschreibt eine nicht-englische).
    if (!cur) out.set(p.oracleId, p.scryfallId);
    else if (p.lang === 'en') out.set(p.oracleId, p.scryfallId);
  }
  return out;
}

/** Ausgaben mehrerer Karten, englische zuerst, höchstens `limit` (Token-Artworks ohne Bild-Index). */
export async function printingsOf(oracleIds: readonly string[], limit: number): Promise<Printing[]> {
  if (oracleIds.length === 0) return [];
  const rows = await db.printings.where('oracleId').anyOf([...new Set(oracleIds)]).toArray();
  rows.sort((a, b) => Number(b.lang === 'en') - Number(a.lang === 'en'));
  return rows.slice(0, limit);
}

/** Sammlungsbestand je oracleId (über alle Finishes summiert) — für „Fehlt mir" & Suche. */
export async function ownedByOracle(): Promise<Map<string, number>> {
  const rows = await db.owned.toArray();
  const map = new Map<string, number>();
  for (const o of rows) map.set(o.oracleId, (map.get(o.oracleId) ?? 0) + o.qty);
  return map;
}

/** Gewählte Druckausgabe (Artwork) je oracleId aus der Sammlung — damit Deck &
 *  Detail dasselbe Artwork wie die Sammlung zeigen (printingId, PLAN.md § 3). */
export async function ownedPrintingByOracle(): Promise<Map<string, string>> {
  const rows = await db.owned.toArray();
  const map = new Map<string, string>();
  for (const o of rows) if (o.printingId && !map.has(o.oracleId)) map.set(o.oracleId, o.printingId);
  return map;
}
