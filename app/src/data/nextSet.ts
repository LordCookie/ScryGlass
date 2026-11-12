import { getMeta, setMeta } from '../db/db';
import { pickNextSet, toSetInfos, type ScryfallSet, type SetInfo, type UpcomingSet } from '../domain/nextSet';
import { scryfallHeaders } from './scryfallHeaders';

/**
 * Holt die Set-Liste von Scryfall (dieselbe Quelle wie der Katalog) und merkt sich
 * das nächste Premier-Set in Dexie (`meta`), damit der Header-Countdown offline
 * weiterläuft. Alles best-effort — Fehler/Offline fallen still auf den Cache zurück.
 */

const META_KEY = 'nextSet';
/** Kompakte Set-Liste (Code/Name/Datum) für den Scanner-Set-Modus — derselbe Abruf. */
const SET_LIST_KEY = 'setList';
const SETS_URL = 'https://api.scryfall.com/sets';

interface CachedNextSet extends UpcomingSet {
  fetchedAt: number;
}

/** Big Screen (M20): das nächste Set kommt vom Handy statt von Scryfall. */
let source: (() => Promise<UpcomingSet | null>) | null = null;
export function setNextSetSource(s: (() => Promise<UpcomingSet | null>) | null): void {
  source = s;
}

export async function getCachedNextSet(): Promise<UpcomingSet | null> {
  const c = await getMeta<CachedNextSet>(META_KEY);
  return c ? { code: c.code, name: c.name, releasedAt: c.releasedAt } : null;
}

/** Aktualisiert das gecachte nächste Set von Scryfall; gibt es (oder den Cache) zurück. */
export async function refreshNextSet(now: Date = new Date()): Promise<UpcomingSet | null> {
  if (source) {
    const next = await source().catch(() => null);
    if (next) await setMeta(META_KEY, { ...next, fetchedAt: Date.now() } satisfies CachedNextSet);
    return next ?? getCachedNextSet();
  }
  try {
    const res = await fetch(SETS_URL, { headers: scryfallHeaders() });
    if (!res.ok) return getCachedNextSet();
    const json = (await res.json()) as { data?: ScryfallSet[] };
    if (json.data?.length) await setMeta(SET_LIST_KEY, toSetInfos(json.data));
    const next = pickNextSet(json.data ?? [], now);
    if (next) await setMeta(META_KEY, { ...next, fetchedAt: Date.now() } satisfies CachedNextSet);
    return next ?? getCachedNextSet();
  } catch {
    return getCachedNextSet();
  }
}

/** Gecachte Set-Liste (leer, solange die App noch nie online war). */
export async function getSetList(): Promise<SetInfo[]> {
  return (await getMeta<SetInfo[]>(SET_LIST_KEY)) ?? [];
}
