import { db, getMeta } from '../db/db';
import { computeSetProgress, type SetProgress } from '../domain/setProgress';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Set-Fortschritt der Sammlung (domain/setProgress). Lädt nur die Sets, in denen man
 * überhaupt etwas besitzt, und merkt sich deren Karten je Katalog-Version im Speicher
 * — das zweite Öffnen ist sofort da. Tokens zählen nicht (weder Bestand noch Set).
 */

let cacheVersion: string | undefined;
const setCardsCache = new Map<string, Set<string>>();

async function cardsOfSet(set: string, tokens: ReadonlySet<string>): Promise<Set<string>> {
  const hit = setCardsCache.get(set);
  if (hit) return hit;
  const ids = new Set<string>();
  await db.printings.where('set').equals(set).each((p) => {
    if (!tokens.has(p.oracleId)) ids.add(p.oracleId);
  });
  setCardsCache.set(set, ids);
  return ids;
}

export async function setProgressFor(ownedOracleIds: readonly string[]): Promise<SetProgress[]> {
  const version = await getMeta<string>('catalogVersion');
  if (version !== cacheVersion) {
    setCardsCache.clear();
    cacheVersion = version;
  }
  const tokens = (await loadTokenCatalog()).oracleIds;
  const owned = new Set(ownedOracleIds.filter((id) => !tokens.has(id)));
  if (owned.size === 0) return [];
  const sets = new Set<string>();
  await db.printings.where('oracleId').anyOf([...owned]).each((p) => {
    sets.add(p.set);
  });
  const setCards = new Map<string, Set<string>>();
  for (const s of sets) setCards.set(s, await cardsOfSet(s, tokens));
  return computeSetProgress(owned, setCards);
}
