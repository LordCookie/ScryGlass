import { getMeta, setMeta } from '../db/db';
import { pickNextSet, type ScryfallSet, type UpcomingSet } from '../domain/nextSet';

/**
 * Holt die Set-Liste von Scryfall (dieselbe Quelle wie der Katalog) und merkt sich
 * das nächste Premier-Set in Dexie (`meta`), damit der Header-Countdown offline
 * weiterläuft. Alles best-effort — Fehler/Offline fallen still auf den Cache zurück.
 */

const META_KEY = 'nextSet';
const SETS_URL = 'https://api.scryfall.com/sets';

interface CachedNextSet extends UpcomingSet {
  fetchedAt: number;
}

export async function getCachedNextSet(): Promise<UpcomingSet | null> {
  const c = await getMeta<CachedNextSet>(META_KEY);
  return c ? { code: c.code, name: c.name, releasedAt: c.releasedAt } : null;
}

/** Aktualisiert das gecachte nächste Set von Scryfall; gibt es (oder den Cache) zurück. */
export async function refreshNextSet(now: Date = new Date()): Promise<UpcomingSet | null> {
  try {
    const res = await fetch(SETS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return getCachedNextSet();
    const json = (await res.json()) as { data?: ScryfallSet[] };
    const next = pickNextSet(json.data ?? [], now);
    if (next) await setMeta(META_KEY, { ...next, fetchedAt: Date.now() } satisfies CachedNextSet);
    return next ?? getCachedNextSet();
  } catch {
    return getCachedNextSet();
  }
}
