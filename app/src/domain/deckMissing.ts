/**
 * „Fehlt-mir"-Liste (PLAN.md § 7): Karten im Deck, die man nicht (genug) besitzt.
 * Reines Zählen: Deckbedarf je oracleId gegen den Sammlungsbestand.
 */
import type { DeckCard } from './types';

export interface MissingRow {
  oracleId: string;
  need: number;
  have: number;
  missing: number;
}

/**
 * `owned` ist oracleId → besessene Gesamtmenge (über alle Finishes summiert).
 * `entries` sind die Deckkarten (Mainboard + ggf. Commander/Sideboard, vom Aufrufer
 * zusammengeführt). Rückgabe: nur Karten mit Fehlmenge, absteigend nach Fehlmenge.
 */
export function computeMissing(
  entries: readonly DeckCard[],
  owned: ReadonlyMap<string, number>,
): MissingRow[] {
  // Deckbedarf je oracleId aufsummieren (eine Karte kann mehrfach vorkommen).
  const need = new Map<string, number>();
  for (const e of entries) need.set(e.oracleId, (need.get(e.oracleId) ?? 0) + e.qty);

  const rows: MissingRow[] = [];
  for (const [oracleId, n] of need) {
    const have = owned.get(oracleId) ?? 0;
    const missing = Math.max(0, n - have);
    if (missing > 0) rows.push({ oracleId, need: n, have, missing });
  }
  rows.sort((a, b) => b.missing - a.missing || (a.oracleId < b.oracleId ? -1 : 1));
  return rows;
}
