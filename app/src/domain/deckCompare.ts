/**
 * Deck-Vergleich (PLAN.md M22): zwei Decks nebeneinander — was nur in A, was nur in B,
 * was in beiden steckt, und welche gemeinsamen Karten die Sammlung nicht für beide
 * gleichzeitig hergibt. Commander zählen mit, das Sideboard nicht. Rein und testbar.
 */
import { commanderIds, type Deck, type DeckCard } from './types';

export interface CompareRow {
  oracleId: string;
  /** Anzahl in Deck A bzw. B (0 = nicht drin) */
  a: number;
  b: number;
}

export interface Shortage {
  oracleId: string;
  /** für beide Decks zusammen */
  need: number;
  have: number;
}

export interface DeckComparison {
  onlyA: CompareRow[];
  onlyB: CompareRow[];
  both: CompareRow[];
  /** gemeinsame Karten, die die Sammlung nicht für beide Decks auf einmal hergibt */
  short: Shortage[];
}

/** Hauptdeck plus Commander, je Karte zusammengezählt. */
export function playedEntries(deck: Pick<Deck, 'cards' | 'commanderId' | 'partnerId'>): DeckCard[] {
  const m = new Map<string, number>();
  for (const c of deck.cards) m.set(c.oracleId, (m.get(c.oracleId) ?? 0) + c.qty);
  for (const id of commanderIds(deck)) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m].map(([oracleId, qty]) => ({ oracleId, qty }));
}

/**
 * `owned`: Bestand je Karte. `skip`: Karten, die für „zu wenig" nicht zählen
 * (Standardländer hat man meist genug). Listen sortiert der Aufrufer nach Namen.
 */
export function compareDecks(
  a: Pick<Deck, 'cards' | 'commanderId' | 'partnerId'>,
  b: Pick<Deck, 'cards' | 'commanderId' | 'partnerId'>,
  owned: ReadonlyMap<string, number>,
  skip: (oracleId: string) => boolean = () => false,
): DeckComparison {
  const qa = new Map(playedEntries(a).map((e) => [e.oracleId, e.qty]));
  const qb = new Map(playedEntries(b).map((e) => [e.oracleId, e.qty]));
  const out: DeckComparison = { onlyA: [], onlyB: [], both: [], short: [] };
  for (const id of new Set([...qa.keys(), ...qb.keys()])) {
    const row = { oracleId: id, a: qa.get(id) ?? 0, b: qb.get(id) ?? 0 };
    if (row.a && row.b) {
      out.both.push(row);
      const have = owned.get(id) ?? 0;
      if (!skip(id) && have < row.a + row.b) out.short.push({ oracleId: id, need: row.a + row.b, have });
    } else if (row.a) out.onlyA.push(row);
    else out.onlyB.push(row);
  }
  return out;
}
