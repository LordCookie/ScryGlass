import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/db';
import type { Card, Printing } from '../domain/types';
import { setProgressFor } from './setProgress';
import { invalidateTokenCatalog } from './tokenCatalog';

/** Set-Fortschritt gegen Dexie: Sets der Sammlung, Karten je Set, ohne Tokens. */

const card = (oracleId: string, layout = 'normal'): Card => ({
  oracleId, name: oracleId, normName: oracleId, manaCost: '', cmc: 0, colors: [], colorIdentity: [],
  typeLine: '', oracleText: '', layout, legalities: 0, maxCopies: 4,
});
const printing = (scryfallId: string, oracleId: string, set: string): Printing => ({
  scryfallId, oracleId, set, collectorNumber: scryfallId, lang: 'en', finishes: ['nonfoil'],
});

beforeAll(async () => {
  await Promise.all([db.cards.clear(), db.printings.clear()]);
  await db.cards.bulkPut([card('a'), card('b'), card('c'), card('d'), card('tok', 'token')]);
  await db.printings.bulkPut([
    printing('1', 'a', 'dmu'), printing('2', 'b', 'dmu'), printing('3', 'c', 'dmu'),
    printing('4', 'a', 'sld'), printing('5', 'tok', 'sld'),
    printing('6', 'd', 'lea'),
  ]);
  invalidateTokenCatalog();
});

describe('setProgressFor', () => {
  it('zählt verschiedene Karten je Set, Tokens weder im Bestand noch im Set', async () => {
    const p = await setProgressFor(['a', 'b', 'tok']);
    const bySet = Object.fromEntries(p.map((x) => [x.set, [x.have, x.total]]));
    expect(bySet).toEqual({ dmu: [2, 3], sld: [1, 1] });
  });

  it('zweiter Aufruf (Sets gemerkt) liefert dasselbe; neue Sets kommen dazu', async () => {
    const p = await setProgressFor(['a', 'b', 'tok', 'd']);
    const bySet = Object.fromEntries(p.map((x) => [x.set, [x.have, x.total]]));
    expect(bySet).toEqual({ dmu: [2, 3], sld: [1, 1], lea: [1, 1] });
  });

  it('ohne Bestand: nichts', async () => {
    expect(await setProgressFor([])).toEqual([]);
    expect(await setProgressFor(['tok'])).toEqual([]);
  });
});
