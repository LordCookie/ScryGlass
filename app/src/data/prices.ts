import { db } from '../db/db';
import { parseScryfallPrices, priceKey, fallbackPriceKey, unitPrice, type PriceEntry } from '../domain/prices';

/**
 * Preise von Scryfall holen (POST /cards/collection, max. 75 Karten je Anfrage) und
 * mit Zeitstempel in Dexie ablegen. Offline bleibt der letzte Stand stehen.
 * In der App läuft `fetch` über CapacitorHttp (kein CORS); im Browser erlaubt
 * Scryfall die Anfrage direkt.
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

/** Holt Preise für die Schlüssel und speichert sie; gibt die Anzahl gefundener zurück. */
export async function fetchPrices(reqs: readonly PriceRequest[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const uniq = [...new Map(reqs.map((r) => [r.key, r])).values()];
  let found = 0;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const chunk = uniq.slice(i, i + BATCH);
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  );
  const prices = await getPrices(owned.map(priceKey));
  const missing = owned.filter((o) => {
    const fb = fallbackPriceKey(o);
    return fb && unitPrice(prices.get(priceKey(o)), o.finish) == null;
  });
  if (missing.length) {
    found += await fetchPrices(missing.map((o) => ({ key: fallbackPriceKey(o)!, oracleId: o.oracleId })));
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

export async function getPrices(keys: readonly string[]): Promise<Map<string, PriceEntry>> {
  const rows = await db.prices.bulkGet([...new Set(keys)]);
  const out = new Map<string, PriceEntry>();
  for (const r of rows) if (r) out.set(r.key, r);
  return out;
}
