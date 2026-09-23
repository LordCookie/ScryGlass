/**
 * Filter für die Sammlungsansicht (PLAN.md § 5, M5). Framework-frei & rein testbar.
 * Suche (Name/Typ/Regeltext) + Farbe wie bisher, dazu Kartentyp, Manawert, Set und
 * Ausführung. Set kennen wir nur bei Beständen mit gemerkter Ausgabe (printingId).
 */
import type { Card, Finish, Owned } from './types';
import { matchesCardFilter, cmcBucket } from './cardFilter';

export { cmcBucket };

export interface CollectionFilter {
  query: string;
  /** W U B R G, oder C = farblos (Farbidentität). */
  color: string | null;
  /** englisches Typwort aus TYPE_FILTERS (typeLine ist englisch). */
  type: string | null;
  /** Manawert 0..7, 7 = „7+". */
  cmc: number | null;
  /** Set-Code, z. B. „dmu". */
  set: string | null;
  finish: Finish | null;
}

export const EMPTY_FILTER: CollectionFilter = {
  query: '', color: null, type: null, cmc: null, set: null, finish: null,
};

export const TYPE_FILTERS: readonly { key: string; label: string }[] = [
  { key: 'Creature', label: 'Kreatur' },
  { key: 'Instant', label: 'Spontanzauber' },
  { key: 'Sorcery', label: 'Hexerei' },
  { key: 'Artifact', label: 'Artefakt' },
  { key: 'Enchantment', label: 'Verzauberung' },
  { key: 'Planeswalker', label: 'Planeswalker' },
  { key: 'Battle', label: 'Schlacht' },
  { key: 'Land', label: 'Land' },
];

/** Englischer Primärtyp → deutsches Label (auch für die Statistik). */
export const TYPE_LABEL: Record<string, string> = Object.fromEntries([
  ...TYPE_FILTERS.map((t) => [t.key, t.label]),
  ['Sonstige', 'Sonstige'],
]);

export interface FilterRow {
  owned: Owned;
  card: Card;
  /** Set der gemerkten Ausgabe, sonst unbekannt. */
  set?: string;
}

export function matchesFilter(r: FilterRow, f: CollectionFilter): boolean {
  const c = r.card;
  const q = f.query.trim().toLowerCase();
  if (q && !(c.name.toLowerCase().includes(q) || c.typeLine.toLowerCase().includes(q) || c.oracleText.toLowerCase().includes(q))) {
    return false;
  }
  // Farbe/Typ/Manawert genauso wie in der Katalogsuche (domain/cardFilter).
  if (!matchesCardFilter(c, { color: f.color, type: f.type, cmc: f.cmc, format: null })) return false;
  if (f.set && r.set !== f.set) return false;
  if (f.finish && r.owned.finish !== f.finish) return false;
  return true;
}

/** Anzahl aktiver Zusatzfilter (Suche/Farbe haben eigene Bedienelemente). */
export function extraFilterCount(f: CollectionFilter): number {
  return [f.type, f.cmc, f.set, f.finish].filter((v) => v != null).length;
}
