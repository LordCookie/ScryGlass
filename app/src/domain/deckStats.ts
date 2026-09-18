/**
 * Deck-Statistik (PLAN.md § 7): Manakurve, Farbverteilung, Landanteil, Typ-
 * Verteilung. Reines Zählen über die Deckliste + Karten-Lookup.
 */
import type { Card, DeckCard } from './types';
import type { CardLookup } from './deckValidate';

export type ColorKey = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export const COLOR_KEYS: ColorKey[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** Manakurven-Buckets: 0,1,2,3,4,5,6,7+ (Index 7 = 7 oder mehr). */
export const CURVE_BUCKETS = 8;

export interface DeckStats {
  total: number;
  lands: number;
  landRatio: number; // 0..1
  /** Nichtland-Karten je CMC-Bucket (qty-gewichtet). */
  manaCurve: number[];
  /** Nichtland-Karten je Farbe (qty-gewichtet; C = farblos). */
  colors: Record<ColorKey, number>;
  /** Karten je Primärtyp (qty-gewichtet). */
  types: Record<string, number>;
}

export function isLand(card: Card): boolean {
  return /\bland\b/i.test(card.typeLine);
}

const TYPE_PRIORITY = [
  'Land',
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
];

export function primaryType(card: Card): string {
  const t = card.typeLine;
  for (const type of TYPE_PRIORITY) {
    if (new RegExp(`\\b${type}\\b`, 'i').test(t)) return type;
  }
  return 'Sonstige';
}

export function computeStats(entries: readonly DeckCard[], cards: CardLookup): DeckStats {
  const manaCurve = new Array<number>(CURVE_BUCKETS).fill(0);
  const colors: Record<ColorKey, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const types: Record<string, number> = {};
  let total = 0;
  let lands = 0;

  for (const e of entries) {
    const card = cards.get(e.oracleId);
    if (!card) continue;
    total += e.qty;

    const type = primaryType(card);
    types[type] = (types[type] ?? 0) + e.qty;

    if (isLand(card)) {
      lands += e.qty;
      continue; // Länder zählen nicht in Kurve/Farbverteilung
    }

    const bucket = Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(card.cmc)));
    manaCurve[bucket] += e.qty;

    if (card.colors.length === 0) colors.C += e.qty;
    else for (const c of card.colors) if (c in colors) colors[c as ColorKey] += e.qty;
  }

  return {
    total,
    lands,
    landRatio: total > 0 ? lands / total : 0,
    manaCurve,
    colors,
    types,
  };
}
