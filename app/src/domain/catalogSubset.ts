/**
 * Big Screen, schneller Start (PLAN.md M20, Vorschlag des Nutzers): Erst bekommt der
 * Browser nur die Katalogdaten der Karten, die in Sammlung, Decks und übernommenen
 * Fertigdecks stehen — der Rest des Katalogs lädt danach im Hintergrund. Hier: welche
 * Karten das sind. Rein und testbar.
 */
import { commanderIds, type Deck, type OwnedBooking } from './types';

export function subsetOracleIds(
  owned: readonly { oracleId: string }[],
  decks: readonly Deck[],
  precons: readonly { items: readonly OwnedBooking[] }[],
): string[] {
  const ids = new Set<string>();
  for (const o of owned) ids.add(o.oracleId);
  for (const d of decks) {
    for (const id of commanderIds(d)) ids.add(id);
    for (const c of [...d.cards, ...d.sideboard]) ids.add(c.oracleId);
  }
  for (const p of precons) for (const it of p.items) ids.add(it.oracleId);
  return [...ids];
}
