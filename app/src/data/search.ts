import { db } from '../db/db';
import { normalizeName } from '../domain/nameMatch';
import type { Card } from '../domain/types';

/**
 * Katalog-Suche für den Deckbau (Präfix über den Namensindex, DE + EN). Nutzt die
 * indizierten `normName`-Spalten in Dexie — schnell auch bei 30k+ Karten.
 */
export async function searchCards(query: string, limit = 20): Promise<Card[]> {
  const q = normalizeName(query);
  if (!q) return [];

  const [byCard, byName] = await Promise.all([
    db.cards.where('normName').startsWith(q).limit(limit).toArray(),
    db.names.where('normName').startsWith(q).limit(limit).toArray(),
  ]);

  const oracleIds = new Set<string>(byCard.map((c) => c.oracleId));
  for (const n of byName) oracleIds.add(n.oracleId);

  const missing = [...oracleIds].filter((id) => !byCard.some((c) => c.oracleId === id));
  const extra = (await db.cards.bulkGet(missing)).filter((c): c is Card => !!c);

  return [...byCard, ...extra]
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit);
}
