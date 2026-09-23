import { describe, it, expect } from 'vitest';
import {
  priceKey, parseScryfallPrices, unitPrice, isStale, collectionValue, formatEur,
  PRICE_MAX_AGE_MS, type PriceEntry,
} from './prices';

describe('Preise', () => {
  it('Schlüssel: gemerkte Ausgabe, sonst Standardausgabe der Karte', () => {
    expect(priceKey({ printingId: 'p1', oracleId: 'o1' })).toBe('p1');
    expect(priceKey({ oracleId: 'o1' })).toBe('oracle:o1');
  });

  it('liest Scryfall-Preise (Strings/null) als Zahlen', () => {
    expect(parseScryfallPrices({ eur: '1.33', eur_foil: '4.63', usd: null, usd_foil: 'x' }))
      .toEqual({ eur: 1.33, eurFoil: 4.63, usd: undefined, usdFoil: undefined });
    expect(parseScryfallPrices(undefined)).toEqual({ eur: undefined, eurFoil: undefined, usd: undefined, usdFoil: undefined });
  });

  it('Stückpreis je Ausführung (Etched nutzt den Foil-Preis)', () => {
    const e: PriceEntry = { key: 'p', eur: 1, eurFoil: 3, at: 0 };
    expect(unitPrice(e, 'nonfoil')).toBe(1);
    expect(unitPrice(e, 'foil')).toBe(3);
    expect(unitPrice(e, 'etched')).toBe(3);
    expect(unitPrice(undefined, 'nonfoil')).toBeUndefined();
  });

  it('veraltet nach 24 h oder ohne Stand', () => {
    expect(isStale(undefined, 1000)).toBe(true);
    expect(isStale(0, PRICE_MAX_AGE_MS)).toBe(false);
    expect(isStale(0, PRICE_MAX_AGE_MS + 1)).toBe(true);
  });

  it('Sammlungswert: summiert Anzahl × Stückpreis, zählt Karten ohne Preis extra', () => {
    const prices = new Map<string, PriceEntry>([
      ['bolt', { key: 'bolt', eur: 1.94, eurFoil: 2.22, at: 200 }],
      ['ring', { key: 'ring', eur: 0.99, at: 100 }],
      ['promo', { key: 'promo', at: 300 }], // kein Euro-Preis
    ]);
    const v = collectionValue(
      [
        { key: 'bolt', finish: 'nonfoil', qty: 3, name: 'Lightning Bolt' },
        { key: 'bolt', finish: 'foil', qty: 1, name: 'Lightning Bolt' },
        { key: 'ring', finish: 'nonfoil', qty: 2, name: 'Sol Ring' },
        { key: 'promo', finish: 'nonfoil', qty: 1, name: 'Promo' },
        { key: 'missing', finish: 'nonfoil', qty: 4, name: 'Unbekannt' },
      ],
      prices,
    );
    expect(v.total).toBe(10.02); // 5,82 + 2,22 + 1,98
    expect(v.pricedQty).toBe(6);
    expect(v.unpricedQty).toBe(5);
    expect(v.top[0]).toMatchObject({ name: 'Lightning Bolt', finish: 'nonfoil', sum: 5.82 });
    expect(v.oldestAt).toBe(100);
  });

  it('formatiert Euro deutsch', () => {
    expect(formatEur(1234.5).replace(/\s/g, ' ')).toBe('1.234,50 €');
    expect(formatEur(undefined)).toBe('—');
  });
});

describe('Ersatzpreis (gemerkte Ausgabe ohne Euro-Preis)', () => {
  it('nutzt die Standardausgabe, wenn die gemerkte Ausgabe keinen Preis hat', async () => {
    const { fallbackPriceKey } = await import('./prices');
    expect(fallbackPriceKey({ printingId: 'de1', oracleId: 'o1' })).toBe('oracle:o1');
    expect(fallbackPriceKey({ oracleId: 'o1' })).toBeUndefined();
    const prices = new Map<string, PriceEntry>([
      ['de1', { key: 'de1', at: 5 }], // deutscher Druck ohne Preis
      ['oracle:o1', { key: 'oracle:o1', eur: 2, eurFoil: 6, at: 7 }],
    ]);
    const v = collectionValue([{ key: 'de1', fallbackKey: 'oracle:o1', finish: 'foil', qty: 2, name: 'X' }], prices);
    expect(v.total).toBe(12);
    expect(v.unpricedQty).toBe(0);
    expect(v.oldestAt).toBe(7);
  });
});

describe('ownedUnitPrice', () => {
  it('nimmt die gemerkte Ausgabe, sonst die Standardausgabe, sonst nichts', async () => {
    const { ownedUnitPrice } = await import('./prices');
    const prices = new Map<string, PriceEntry>([
      ['en1', { key: 'en1', eur: 5, at: 0 }],
      ['de1', { key: 'de1', at: 0 }],
      ['oracle:o1', { key: 'oracle:o1', eur: 4, at: 0 }],
    ]);
    expect(ownedUnitPrice({ printingId: 'en1', oracleId: 'o1', finish: 'nonfoil' }, prices)).toBe(5);
    expect(ownedUnitPrice({ printingId: 'de1', oracleId: 'o1', finish: 'nonfoil' }, prices)).toBe(4);
    expect(ownedUnitPrice({ oracleId: 'o1', finish: 'nonfoil' }, prices)).toBe(4);
    expect(ownedUnitPrice({ oracleId: 'o2', finish: 'nonfoil' }, prices)).toBeUndefined();
  });
});
