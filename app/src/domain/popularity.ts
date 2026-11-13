/**
 * Beliebtheit (PLAN.md M22): der EDHREC-Rang, wie Scryfall ihn mitliefert (1 = in den
 * meisten Commander-Decks). Keine eigenen Zahlen, keine EDHREC-Daten direkt — nur
 * sortieren, einordnen und für Decks zusammenfassen. Rein und testbar.
 */
import type { Card } from './types';

/** Karten mit Rang zuerst (kleiner = beliebter), ohne Rang ans Ende; dann nach Name. */
export function byPopularity(a: Pick<Card, 'name' | 'edhrecRank'>, b: Pick<Card, 'name' | 'edhrecRank'>): number {
  const ra = a.edhrecRank ?? Number.POSITIVE_INFINITY;
  const rb = b.edhrecRank ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export type Tier = 'top' | 'beliebt' | 'gaengig' | 'selten';

/** Grobe Einordnung für Texte und Vorschläge. */
export function popularityTier(rank: number | undefined): Tier | null {
  if (rank == null) return null;
  if (rank <= 250) return 'top';
  if (rank <= 2000) return 'beliebt';
  if (rank <= 8000) return 'gaengig';
  return 'selten';
}

export const TIER_LABEL: Record<Tier, string> = {
  top: 'sehr beliebt',
  beliebt: 'beliebt',
  gaengig: 'gängig',
  selten: 'selten gespielt',
};

const nf = new Intl.NumberFormat('de-DE');

/** „Platz 412 · beliebt" — oder null ohne Rang. */
export function rankLabel(rank: number | undefined): string | null {
  const tier = popularityTier(rank);
  return tier && rank != null ? `Platz ${nf.format(rank)} · ${TIER_LABEL[tier]}` : null;
}

export interface DeckPopularity {
  /** Median-Rang der Karten mit Rang (robuster als der Schnitt) */
  median: number | null;
  ranked: number;
  total: number;
  /** die beliebtesten (kleinster Rang) */
  most: Card[];
  /** die ungewöhnlichsten — Geheimtipps oder Kandidaten zum Austauschen */
  least: Card[];
}

/** Beliebtheit eines Decks; Standardländer zählen nicht (die sind immer vorn). */
export function deckPopularity(cards: readonly Card[], n = 5): DeckPopularity {
  const unique = [...new Map(cards.map((c) => [c.oracleId, c])).values()]
    .filter((c) => !(/\bBasic\b/.test(c.typeLine) && /\bLand\b/.test(c.typeLine)));
  const ranked = unique.filter((c) => c.edhrecRank != null).sort(byPopularity);
  const mid = ranked.length ? ranked[Math.floor((ranked.length - 1) / 2)].edhrecRank! : null;
  // Kleine Decks: vorn die beliebtere Hälfte, hinten der Rest — keine Karte in beiden Listen.
  const most = ranked.slice(0, Math.min(n, Math.ceil(ranked.length / 2)));
  return {
    median: mid,
    ranked: ranked.length,
    total: unique.length,
    most,
    least: ranked.slice(most.length).slice(-n).reverse(),
  };
}
