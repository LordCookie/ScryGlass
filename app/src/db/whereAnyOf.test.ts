import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db, whereAnyOf } from './db';
import type { Printing } from '../domain/types';

/** Ersatz für `anyOf` (viele Schlüssel): dieselben Zeilen in derselben Reihenfolge. */

let seed = 99;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
const hex = () => Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0');

describe('whereAnyOf', () => {
  const oracles = Array.from({ length: 60 }, () => hex());
  const sets = ['lea', 'dmu', 'sld', 'tblb', 'm21'];

  beforeAll(async () => {
    await db.printings.clear();
    const rows: Printing[] = Array.from({ length: 400 }, () => ({
      scryfallId: `${hex()}-${hex()}`,
      oracleId: oracles[Math.floor(rnd() * oracles.length)],
      set: sets[Math.floor(rnd() * sets.length)],
      collectorNumber: String(Math.floor(rnd() * 300)),
      lang: rnd() < 0.7 ? 'en' : 'de',
      finishes: ['nonfoil'],
    }));
    await db.printings.bulkPut(rows);
  });

  it('liefert genau das, was anyOf liefert — auch mit doppelten und fehlenden Schlüsseln', async () => {
    const keys = [...oracles.filter((_, i) => i % 3 === 0), oracles[0], oracles[3], 'fehlt-1', 'fehlt-2'];
    const want = await db.printings.where('oracleId').anyOf(keys).toArray();
    const got = await whereAnyOf(db.printings, 'oracleId', keys);
    expect(got.map((p) => p.scryfallId)).toEqual(want.map((p) => p.scryfallId));
    expect(got.length).toBeGreaterThan(0);
  });

  it('funktioniert für jeden Index (hier: set)', async () => {
    const want = await db.printings.where('set').anyOf(['sld', 'tblb']).toArray();
    const got = await whereAnyOf(db.printings, 'set', ['tblb', 'sld']);
    expect(got.map((p) => p.scryfallId)).toEqual(want.map((p) => p.scryfallId));
  });

  it('keine Schlüssel = leeres Ergebnis', async () => {
    expect(await whereAnyOf(db.printings, 'oracleId', [])).toEqual([]);
  });
});
