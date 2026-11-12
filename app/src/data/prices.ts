import { db } from '../db/db';
import { parseScryfallPrices, priceKey, fallbackPriceKey, unitPrice, isStale, type PriceEntry, type ValueRow } from '../domain/prices';
import { scryfallHeaders } from './scryfallHeaders';

/**
 * Preise von Scryfall holen (POST /cards/collection, max. 75 Karten je Anfrage) und
 * mit Zeitstempel in Dexie ablegen. Offline bleibt der letzte Stand stehen.
 * In der App läuft `fetch` über CapacitorHttp (kein CORS); im Browser erlaubt
 * Scryfall die Anfrage direkt.
 *
 * Big Screen (M20, local-first): Der Browser fragt nicht Scryfall, sondern das Handy
 * (`setPriceSource`). Das Handy antwortet aus seinem eigenen Preis-Speicher und holt nur
 * Veraltetes (älter als einen Tag) oder bei „Preise aktualisieren" alles frisch.
 */

const URL = 'https://api.scryfall.com/cards/collection';
const BATCH = 75;
const PAUSE_MS = 100; // Scryfall bittet um 50–100 ms zwischen Anfragen

interface PriceRequest {
  key: string;
  id?: string;
  oracleId?: string;
}

interface ScryfallCard {
  id: string;
  oracle_id?: string;
  prices?: Record<string, string | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Woher die Preise kommen, wenn nicht direkt von Scryfall (Big Screen: vom Handy). */
export type PriceSource = (keys: string[], force: boolean) => Promise<PriceEntry[]>;
let source: PriceSource | null = null;
/** So viele Schlüssel je Anfrage ans Handy — es fragt Scryfall in 75er-Paketen mit Pause. */
const REMOTE_BATCH = 150;

export function setPriceSource(s: PriceSource | null): void {
  source = s;
}

/**
 * Holt Preise für die Schlüssel und speichert sie; gibt die Anzahl gefundener zurück.
 * `force`: auch beim Handy frisch holen lassen (nur „Preise aktualisieren").
 */
export async function fetchPrices(
  reqs: readonly PriceRequest[],
  onProgress?: (done: number, total: number) => void,
  opts: { force?: boolean } = {},
): Promise<number> {
  const uniq = [...new Map(reqs.map((r) => [r.key, r])).values()];
  let found = 0;
  if (source) {
    for (let i = 0; i < uniq.length; i += REMOTE_BATCH) {
      const rows = await source(uniq.slice(i, i + REMOTE_BATCH).map((r) => r.key), !!opts.force);
      if (rows.length) await db.prices.bulkPut(rows);
      found += rows.length;
      onProgress?.(Math.min(i + REMOTE_BATCH, uniq.length), uniq.length);
    }
    return found;
  }
  for (let i = 0; i < uniq.length; i += BATCH) {
    const chunk = uniq.slice(i, i + BATCH);
    const res = await fetch(URL, {
      method: 'POST',
      headers: scryfallHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ identifiers: chunk.map((r) => (r.id ? { id: r.id } : { oracle_id: r.oracleId })) }),
    });
    if (!res.ok) throw new Error(`Scryfall antwortet mit ${res.status}`);
    const json = (await res.json()) as { data?: ScryfallCard[] };
    const byId = new Map<string, ScryfallCard>();
    const byOracle = new Map<string, ScryfallCard>();
    for (const c of json.data ?? []) {
      byId.set(c.id, c);
      if (c.oracle_id) byOracle.set(c.oracle_id, c);
    }
    const at = Date.now();
    const rows: PriceEntry[] = [];
    for (const r of chunk) {
      const card = r.id ? byId.get(r.id) : r.oracleId ? byOracle.get(r.oracleId) : undefined;
      if (!card) continue;
      rows.push({ key: r.key, at, ...parseScryfallPrices(card.prices) });
    }
    await db.prices.bulkPut(rows);
    found += rows.length;
    onProgress?.(Math.min(i + BATCH, uniq.length), uniq.length);
    if (i + BATCH < uniq.length) await sleep(PAUSE_MS);
  }
  return found;
}

/**
 * Preise für die ganze Sammlung aktualisieren. Zweiter Durchgang: wo die gemerkte
 * Ausgabe keinen Euro-Preis hat (z. B. deutsche Drucke), die Standardausgabe holen.
 */
export async function refreshCollectionPrices(onProgress?: (done: number, total: number) => void): Promise<number> {
  const owned = await db.owned.toArray();
  let found = await fetchPrices(
    owned.map((o) => ({ key: priceKey(o), id: o.printingId, oracleId: o.printingId ? undefined : o.oracleId })),
    onProgress,
    { force: true },
  );
  const prices = await getPrices(owned.map(priceKey));
  const missing = owned.filter((o) => {
    const fb = fallbackPriceKey(o);
    return fb && unitPrice(prices.get(priceKey(o)), o.finish) == null;
  });
  if (missing.length) {
    found += await fetchPrices(missing.map((o) => ({ key: fallbackPriceKey(o)!, oracleId: o.oracleId })), undefined, { force: true });
  }
  return found;
}

/** Preis einer einzelnen Ausgabe (Kartendetail); nutzt den Cache, holt bei Bedarf neu. */
export async function priceForPrinting(scryfallId: string, maxAgeMs: number): Promise<PriceEntry | undefined> {
  const cached = await db.prices.get(scryfallId);
  if (cached && Date.now() - cached.at <= maxAgeMs) return cached;
  try {
    await fetchPrices([{ key: scryfallId, id: scryfallId }]);
  } catch {
    /* offline — dann eben der alte Stand */
  }
  return (await db.prices.get(scryfallId)) ?? cached;
}

/** Preis-Schlüssel → Scryfall-Anfrage („oracle:<id>" = Standardausgabe, sonst scryfallId). */
function requestFor(key: string): PriceRequest {
  return key.startsWith('oracle:') ? { key, oracleId: key.slice(7) } : { key, id: key };
}

/**
 * Preise für Wert-Zeilen (Deck-Wert, Fehlt-mir-Kosten): fehlende/veraltete Schlüssel
 * nachladen, danach den Ersatz (Standardausgabe) für Zeilen ohne Preis. Ohne Netz zählt
 * der gespeicherte Stand — wirft nie.
 */
export async function ensureRowPrices(rows: readonly ValueRow[]): Promise<Map<string, PriceEntry>> {
  const now = Date.now();
  const load = async (keys: string[]) => {
    const have = await getPrices(keys);
    const todo = [...new Set(keys)].filter((k) => isStale(have.get(k)?.at, now));
    if (todo.length) {
      try {
        await fetchPrices(todo.map(requestFor));
      } catch {
        /* offline/Fehler: letzter Stand bleibt */
      }
    }
  };
  await load(rows.map((r) => r.key));
  let prices = await getPrices(rows.map((r) => r.key));
  const fallbacks = rows
    .filter((r) => r.fallbackKey && unitPrice(prices.get(r.key), r.finish) == null)
    .map((r) => r.fallbackKey!);
  if (fallbacks.length) await load(fallbacks);
  prices = await getPrices([...rows.map((r) => r.key), ...fallbacks]);
  return prices;
}

const PRICE_KEY = /^(oracle:)?[0-9a-f-]{36}$/;

/**
 * Am Handy für den Big Screen: Preise aus dem eigenen Speicher; was fehlt oder älter als
 * einen Tag ist (bei `force` alles), frisch von Scryfall. Offline: der letzte Stand.
 */
export async function pricesForKeys(keys: readonly unknown[], force = false): Promise<PriceEntry[]> {
  const uniq = [...new Set(keys.filter((k): k is string => typeof k === 'string' && PRICE_KEY.test(k)))].slice(0, 300);
  const have = await getPrices(uniq);
  const now = Date.now();
  const todo = force ? uniq : uniq.filter((k) => isStale(have.get(k)?.at, now));
  if (todo.length) {
    try {
      await fetchPrices(todo.map(requestFor));
    } catch {
      /* offline: letzter Stand */
    }
  }
  return [...(await getPrices(uniq)).values()];
}

export async function getPrices(keys: readonly string[]): Promise<Map<string, PriceEntry>> {
  const rows = await db.prices.bulkGet([...new Set(keys)]);
  const out = new Map<string, PriceEntry>();
  for (const r of rows) if (r) out.set(r.key, r);
  return out;
}
