import { db, getMeta, whereAnyOf } from '../db/db';
import { computeSetProgress, type SetProgress } from '../domain/setProgress';
import { loadTokenCatalog } from './tokenCatalog';

/**
 * Set-Fortschritt der Sammlung (domain/setProgress). Lädt nur die Sets, in denen man
 * überhaupt etwas besitzt, und merkt sich deren Karten je Katalog-Version im Speicher
 * — das zweite Öffnen ist sofort da. Tokens zählen nicht (weder Bestand noch Set).
 */

let cacheVersion: string | undefined;
const setCardsCache = new Map<string, Set<string>>();

export async function setProgressFor(ownedOracleIds: readonly string[]): Promise<SetProgress[]> {
  const version = await getMeta<string>('catalogVersion');
  if (version !== cacheVersion) {
    setCardsCache.clear();
    cacheVersion = version;
  }
  const tokens = (await loadTokenCatalog()).oracleIds;
  const owned = new Set(ownedOracleIds.filter((id) => !tokens.has(id)));
  if (owned.size === 0) return [];
  const sets = new Set((await whereAnyOf(db.printings, 'oracleId', [...owned])).map((p) => p.set));
  // Karten der noch nicht gemerkten Sets auf einmal laden (früher Set für Set per Cursor,
  // also ein Umlauf je Zeile).
  const missing = [...sets].filter((s) => !setCardsCache.has(s));
  if (missing.length > 0) {
    const fresh = new Map(missing.map((s) => [s, new Set<string>()]));
    for (const p of await whereAnyOf(db.printings, 'set', missing)) {
      if (!tokens.has(p.oracleId)) fresh.get(p.set)?.add(p.oracleId);
    }
    for (const [s, ids] of fresh) setCardsCache.set(s, ids);
  }
  const setCards = new Map([...sets].map((s) => [s, setCardsCache.get(s) ?? new Set<string>()]));
  return computeSetProgress(owned, setCards);
}
