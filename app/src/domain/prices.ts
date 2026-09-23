/**
 * Preise & Sammlungswert. Framework-frei & rein testbar.
 *
 * Quelle: Scryfall (Cardmarket-Euro-Preise), live geholt und mit Zeitstempel lokal
 * gespeichert — offline zeigt die App den letzten Stand. Scryfall selbst nennt Preise
 * nach ~24 h veraltet, deshalb wird der Stand immer mit angezeigt.
 *
 * Preis-Schlüssel: gemerkte Ausgabe (printingId) → genau deren Preis; sonst die
 * Scryfall-Standardausgabe der Karte (Schlüssel „oracle:<oracleId>"). Hat die gemerkte
 * Ausgabe keinen Euro-Preis (typisch für deutsche Drucke — Cardmarket führt den Preis
 * an der englischen Ausgabe), gilt ersatzweise der Standardpreis der Karte.
 */
import type { Finish, Owned } from './types';

export interface PriceEntry {
  /** scryfallId der Ausgabe oder „oracle:<oracleId>" (Standardausgabe) */
  key: string;
  eur?: number;
  eurFoil?: number;
  usd?: number;
  usdFoil?: number;
  /** Zeitpunkt des Abrufs (ms) */
  at: number;
}

/** Preise gelten nach Scryfall ab ~24 h als veraltet. */
export const PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function priceKey(o: Pick<Owned, 'printingId' | 'oracleId'>): string {
  return o.printingId ?? `oracle:${o.oracleId}`;
}

/** Ersatz-Schlüssel (Standardausgabe), falls die gemerkte Ausgabe keinen Preis hat. */
export function fallbackPriceKey(o: Pick<Owned, 'printingId' | 'oracleId'>): string | undefined {
  return o.printingId ? `oracle:${o.oracleId}` : undefined;
}

/** Scryfall-Preisobjekt (Strings oder null) → Zahlen. */
export function parseScryfallPrices(p: Record<string, string | null | undefined> | undefined): Omit<PriceEntry, 'key' | 'at'> {
  const num = (v: string | null | undefined) => {
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return { eur: num(p?.eur), eurFoil: num(p?.eur_foil), usd: num(p?.usd), usdFoil: num(p?.usd_foil) };
}

/** Stückpreis in € für eine Ausführung (Etched: kein eigener Euro-Preis → Foil-Preis). */
export function unitPrice(e: PriceEntry | undefined, finish: Finish): number | undefined {
  if (!e) return undefined;
  return finish === 'nonfoil' ? e.eur : e.eurFoil;
}

export function isStale(at: number | undefined, now: number, maxAge = PRICE_MAX_AGE_MS): boolean {
  return at == null || now - at > maxAge;
}

export interface ValueRow {
  key: string;
  /** Standardausgabe, falls `key` keinen Preis für die Ausführung hat */
  fallbackKey?: string;
  finish: Finish;
  qty: number;
  name: string;
}

export interface CollectionValue {
  total: number;
  /** Karten (Stück) mit / ohne bekannten Preis */
  pricedQty: number;
  unpricedQty: number;
  /** wertvollste Positionen (Stückpreis × Anzahl), absteigend */
  top: { name: string; finish: Finish; qty: number; unit: number; sum: number }[];
  /** ältester Preisstand der bewerteten Karten */
  oldestAt?: number;
}

export function collectionValue(rows: readonly ValueRow[], prices: ReadonlyMap<string, PriceEntry>, topN = 5): CollectionValue {
  let total = 0;
  let pricedQty = 0;
  let unpricedQty = 0;
  let oldestAt: number | undefined;
  const top: CollectionValue['top'] = [];
  for (const r of rows) {
    let e = prices.get(r.key);
    let unit = unitPrice(e, r.finish);
    if (unit == null && r.fallbackKey) {
      e = prices.get(r.fallbackKey);
      unit = unitPrice(e, r.finish);
    }
    if (unit == null) {
      unpricedQty += r.qty;
      continue;
    }
    const sum = unit * r.qty;
    total += sum;
    pricedQty += r.qty;
    if (e && (oldestAt == null || e.at < oldestAt)) oldestAt = e.at;
    top.push({ name: r.name, finish: r.finish, qty: r.qty, unit, sum });
  }
  top.sort((a, b) => b.sum - a.sum || a.name.localeCompare(b.name));
  return { total: Math.round(total * 100) / 100, pricedQty, unpricedQty, top: top.slice(0, topN), oldestAt };
}

const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export function formatEur(n: number | undefined): string {
  return n == null ? '—' : eurFmt.format(n);
}

/** Stückpreis eines Bestands (gemerkte Ausgabe, sonst Ersatz über die Standardausgabe). */
export function ownedUnitPrice(
  o: Pick<Owned, 'printingId' | 'oracleId' | 'finish'>,
  prices: ReadonlyMap<string, PriceEntry>,
): number | undefined {
  const own = unitPrice(prices.get(priceKey(o)), o.finish);
  if (own != null) return own;
  const fb = fallbackPriceKey(o);
  return fb ? unitPrice(prices.get(fb), o.finish) : undefined;
}
