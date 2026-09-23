/**
 * Sammlungs-Statistik (Übersicht). Framework-frei & rein testbar. Nutzt die schon
 * getestete Deck-Statistik (Kurve/Farben/Typen) und ergänzt Sammlungs-Kennzahlen:
 * Karten gesamt, verschiedene, Foils und die häufigsten Sets.
 */
import type { Card, DeckCard } from './types';
import { computeStats, type DeckStats } from './deckStats';
import type { FilterRow } from './collectionFilter';

export interface CollectionSummary {
  total: number;
  distinct: number;
  /** Foil + Etched. */
  foil: number;
  /** Sets nach Anzahl (absteigend, max. `topSets`). */
  sets: { set: string; qty: number }[];
  /** Karten mit bekannter Ausgabe (nur die haben ein Set). */
  knownSetQty: number;
  stats: DeckStats;
}

export function summarizeCollection(rows: readonly FilterRow[], topSets = 8): CollectionSummary {
  const byOracle = new Map<string, number>();
  const cards = new Map<string, Card>();
  const setQty = new Map<string, number>();
  let total = 0;
  let foil = 0;
  let knownSetQty = 0;

  for (const r of rows) {
    const q = r.owned.qty;
    total += q;
    if (r.owned.finish !== 'nonfoil') foil += q;
    byOracle.set(r.owned.oracleId, (byOracle.get(r.owned.oracleId) ?? 0) + q);
    cards.set(r.card.oracleId, r.card);
    if (r.set) {
      setQty.set(r.set, (setQty.get(r.set) ?? 0) + q);
      knownSetQty += q;
    }
  }

  const entries: DeckCard[] = [...byOracle].map(([oracleId, qty]) => ({ oracleId, qty }));
  const sets = [...setQty]
    .map(([set, qty]) => ({ set, qty }))
    .sort((a, b) => b.qty - a.qty || a.set.localeCompare(b.set))
    .slice(0, topSets);

  return { total, distinct: byOracle.size, foil, sets, knownSetQty, stats: computeStats(entries, cards) };
}
