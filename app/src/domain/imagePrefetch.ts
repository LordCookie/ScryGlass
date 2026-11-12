/**
 * Vorladen der Kartenbilder im Big Screen (PLAN.md M20): Welche Bilder braucht der Browser
 * sicher? Erst Decks (Commander zuerst), dann die Sammlung — jeweils in der gewählten
 * Ausgabe, sonst die Standard-Vorschau. Alles andere (weitere Ausgaben, Suche) lädt erst,
 * wenn es gebraucht wird. Rein und testbar; geladen wird in bigscreen/prefetch.ts.
 */
import { commanderIds, type Deck } from './types';

export interface PrefetchOwned {
  oracleId: string;
  printingId?: string;
}

/** Höchstens so viele Bilder vorladen (≈ 80 KB je Bild in „normal"). */
export const PREFETCH_MAX = 2500;

export function prefetchOrder(
  decks: readonly Deck[],
  owned: readonly PrefetchOwned[],
  preview: ReadonlyMap<string, string>,
  max = PREFETCH_MAX,
): string[] {
  const chosen = new Map<string, string>();
  for (const o of owned) if (o.printingId && !chosen.has(o.oracleId)) chosen.set(o.oracleId, o.printingId);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (!id || seen.has(id) || out.length >= max) return;
    seen.add(id);
    out.push(id);
  };
  // Neueste Decks zuerst — die öffnet man am ehesten.
  const byDate = [...decks].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const d of byDate) for (const id of commanderIds(d)) add(chosen.get(id) ?? preview.get(id));
  for (const d of byDate) for (const c of [...d.cards, ...d.sideboard]) add(chosen.get(c.oracleId) ?? preview.get(c.oracleId));
  // Sammlung: genau das Bild, das das Raster zeigt (Artwork der Zeile, sonst Vorschau).
  for (const o of owned) add(o.printingId ?? preview.get(o.oracleId));
  return out;
}

/** Alle oracleIds, für die eine Vorschau gebraucht wird. */
export function prefetchOracleIds(decks: readonly Deck[], owned: readonly PrefetchOwned[]): string[] {
  const ids = new Set<string>();
  for (const d of decks) {
    for (const id of commanderIds(d)) ids.add(id);
    for (const c of [...d.cards, ...d.sideboard]) ids.add(c.oracleId);
  }
  for (const o of owned) if (!o.printingId) ids.add(o.oracleId);
  return [...ids];
}
