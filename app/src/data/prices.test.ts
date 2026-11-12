import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { db } from '../db/db';
import { fetchPrices, refreshCollectionPrices, getPrices, pricesForKeys, setPriceSource } from './prices';

type Ident = { id?: string; oracle_id?: string };

/** Nachgebautes Scryfall /cards/collection: bekannte IDs bekommen Preise, „x…" ist unbekannt. */
function fakeScryfall() {
  const calls: Ident[][] = [];
  const fn = vi.fn(async (_url: string, init: { body: string }) => {
    const { identifiers } = JSON.parse(init.body) as { identifiers: Ident[] };
    calls.push(identifiers);
    const data = identifiers
      .filter((i) => !(i.id ?? i.oracle_id ?? '').startsWith('x'))
      .map((i) => ({
        id: i.id ?? `default-of-${i.oracle_id}`,
        oracle_id: i.oracle_id ?? `o-${i.id}`,
        prices: { eur: '1.50', eur_foil: '3.00', usd: '1.00', usd_foil: null },
      }));
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

describe('Preise von Scryfall', () => {
  beforeEach(async () => {
    await db.prices.clear();
    await db.owned.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fragt in Paketen zu 75 an und speichert die Preise', async () => {
    const calls = fakeScryfall();
    const reqs = Array.from({ length: 160 }, (_, i) => ({ key: `p${i}`, id: `p${i}` }));
    const found = await fetchPrices(reqs);
    expect(calls.map((c) => c.length)).toEqual([75, 75, 10]);
    expect(found).toBe(160);
    expect(await db.prices.get('p42')).toMatchObject({ eur: 1.5, eurFoil: 3, usd: 1 });
  });

  it('ordnet Ausgabe- und Standard-Abfragen zu, überspringt Unbekanntes, fragt doppelte Schlüssel nur einmal', async () => {
    const calls = fakeScryfall();
    const found = await fetchPrices([
      { key: 'p1', id: 'p1' },
      { key: 'oracle:o9', oracleId: 'o9' },
      { key: 'p1', id: 'p1' },
      { key: 'x-weg', id: 'x-weg' },
    ]);
    expect(calls[0]).toEqual([{ id: 'p1' }, { oracle_id: 'o9' }, { id: 'x-weg' }]);
    expect(found).toBe(2);
    const m = await getPrices(['p1', 'oracle:o9', 'x-weg']);
    expect([...m.keys()].sort()).toEqual(['oracle:o9', 'p1']);
  });

  it('Sammlung: gemerkte Ausgabe per ID, sonst Standardausgabe per Karte', async () => {
    const calls = fakeScryfall();
    await db.owned.bulkPut([
      { oracleId: 'oA', printingId: 'pA', finish: 'nonfoil', qty: 2, addedAt: 0, source: 'manual' },
      { oracleId: 'oA', printingId: 'pA', finish: 'foil', qty: 1, addedAt: 0, source: 'manual' },
      { oracleId: 'oB', finish: 'nonfoil', qty: 1, addedAt: 0, source: 'scan' },
    ]);
    await refreshCollectionPrices();
    expect(calls[0]).toEqual([{ id: 'pA' }, { oracle_id: 'oB' }]);
    expect(await db.prices.get('oracle:oB')).toMatchObject({ eur: 1.5 });
  });

  it('bricht bei einem Fehler von Scryfall ab (damit die UI das melden kann)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    await expect(fetchPrices([{ key: 'p1', id: 'p1' }])).rejects.toThrow('429');
  });
});

describe('Ersatzpreis beim Aktualisieren', () => {
  beforeEach(async () => {
    await db.prices.clear();
    await db.owned.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('holt die Standardausgabe nach, wenn der gemerkte (deutsche) Druck keinen Preis hat', async () => {
    const calls: { id?: string; oracle_id?: string }[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const { identifiers } = JSON.parse(init.body) as { identifiers: { id?: string; oracle_id?: string }[] };
      calls.push(identifiers);
      const data = identifiers.map((i) => ({
        id: i.id ?? 'std',
        oracle_id: i.oracle_id ?? 'oDE',
        prices: i.id === 'de1' ? { eur: null, eur_foil: null } : { eur: '2.00', eur_foil: '6.00' },
      }));
      return { ok: true, status: 200, json: async () => ({ data }) };
    }));
    await db.owned.put({ oracleId: 'oDE', printingId: 'de1', finish: 'nonfoil', qty: 1, addedAt: 0, source: 'manual' });
    await refreshCollectionPrices();
    expect(calls).toEqual([[{ id: 'de1' }], [{ oracle_id: 'oDE' }]]);
    expect(await db.prices.get('oracle:oDE')).toMatchObject({ eur: 2 });
  });
});

describe('Preise im Big Screen (M20, übers Handy)', () => {
  const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  beforeEach(async () => {
    await db.prices.clear();
  });
  afterEach(() => {
    setPriceSource(null);
    vi.unstubAllGlobals();
  });

  it('Browser: fragt das Handy in 150er-Paketen, nicht Scryfall', async () => {
    const scryfall = vi.fn();
    vi.stubGlobal('fetch', scryfall);
    const asked: { n: number; force: boolean }[] = [];
    setPriceSource(async (keys, force) => {
      asked.push({ n: keys.length, force });
      return keys.map((key) => ({ key, at: 1, eur: 2 }));
    });
    const reqs = Array.from({ length: 200 }, (_, i) => ({ key: ID(i), id: ID(i) }));
    expect(await fetchPrices(reqs)).toBe(200);
    expect(asked).toEqual([{ n: 150, force: false }, { n: 50, force: false }]);
    expect(scryfall).not.toHaveBeenCalled();
    expect((await db.prices.get(ID(7)))?.eur).toBe(2);
  });

  it('Handy: antwortet aus dem Speicher, holt nur Veraltetes (bei force alles), ignoriert Unsinn', async () => {
    const calls = fakeScryfall();
    await db.prices.bulkPut([
      { key: ID(1), at: Date.now(), eur: 9 },
      { key: ID(2), at: Date.now() - 3 * 24 * 60 * 60 * 1000, eur: 9 },
    ]);
    const out = await pricesForKeys([ID(1), ID(2), `oracle:${ID(3)}`, 'kaputt', 42]);
    expect(calls.flat()).toEqual([{ id: ID(2) }, { oracle_id: ID(3) }]);
    expect(out.find((p) => p.key === ID(1))?.eur).toBe(9);
    expect(out.find((p) => p.key === ID(2))?.eur).toBe(1.5);
    expect(out).toHaveLength(3);
    await pricesForKeys([ID(1)], true);
    expect(calls.at(-1)).toEqual([{ id: ID(1) }]);
  });
});
