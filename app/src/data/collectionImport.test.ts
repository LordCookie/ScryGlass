import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/db';
import type { Card } from '../domain/types';
import { parseCollectionCsv } from '../domain/collectionCsv';
import { resolveCsvRows, applyCsvImport } from './collectionImport';

function card(oracleId: string, name: string, normName: string, layout = 'normal'): Card {
  return {
    oracleId, name, normName, layout, manaCost: '', cmc: 0, colors: [], colorIdentity: [],
    typeLine: '', oracleText: '', legalities: 0, maxCopies: 4,
  };
}

beforeEach(async () => {
  await Promise.all([db.cards.clear(), db.printings.clear(), db.names.clear(), db.owned.clear()]);
  await db.cards.bulkPut([
    card('bolt', 'Lightning Bolt', 'lightning bolt'),
    card('ring', 'Sol Ring', 'sol ring'),
    card('soldier-card', 'Soldier', 'soldier'),
    card('soldier-token', 'Soldier', 'soldier', 'token'),
    card('treasure', 'Treasure', 'treasure', 'token'),
  ]);
  await db.printings.bulkPut([
    { scryfallId: 'bolt-2xm', oracleId: 'bolt', set: '2xm', collectorNumber: '117', lang: 'en', finishes: ['nonfoil', 'foil'] },
    { scryfallId: 'ring-c21', oracleId: 'ring', set: 'c21', collectorNumber: '263', lang: 'en', finishes: ['nonfoil'] },
  ]);
  await db.names.bulkPut([
    { normName: 'lightning bolt', oracleId: 'bolt', lang: 'en' },
    { normName: 'blitzschlag', oracleId: 'bolt', lang: 'de' },
    { normName: 'sol ring', oracleId: 'ring', lang: 'en' },
  ]);
});

describe('Sammlungs-CSV auflösen', () => {
  it('Scryfall-ID, dann Set + Nummer (fremde Sprache → englische Ausgabe), dann Name', async () => {
    const { rows } = parseCollectionCsv([
      'Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Language',
      'Lightning Bolt,2xm,117,foil,2,BOLT-2XM,en',
      'Sol Ring,c21,263,normal,1,unbekannte-id,ja',
      'Blitzschlag,,,normal,3,,de',
      'Treasure,,,normal,5,,en',
      'Gibtsnicht,,,normal,1,,en',
    ].join('\n'));
    const r = await resolveCsvRows(rows);
    expect(r.items).toEqual([
      { oracleId: 'bolt', printingId: 'bolt-2xm', finish: 'foil', qty: 2, kind: 'collection' },
      { oracleId: 'ring', printingId: 'ring-c21', finish: 'nonfoil', qty: 1, kind: 'collection' },
      { oracleId: 'bolt', finish: 'nonfoil', qty: 3, kind: 'collection' },
      { oracleId: 'treasure', finish: 'nonfoil', qty: 5, kind: 'collection' },
    ]);
    expect(r.unresolved).toEqual([{ label: 'Gibtsnicht', qty: 1, kind: 'collection' }]);
  });

  it('gleichnamig: echte Karte vor Token', async () => {
    const r = await resolveCsvRows(parseCollectionCsv('Name\nSoldier\n').rows);
    expect(r.items[0].oracleId).toBe('soldier-card');
  });
});

describe('Sammlungs-CSV übernehmen', () => {
  it('Hinzufügen zählt zum Bestand dazu und fasst gleiche Karten zusammen', async () => {
    await db.owned.add({ oracleId: 'bolt', finish: 'nonfoil', qty: 1, addedAt: 1, source: 'scan' });
    await applyCsvImport([
      { oracleId: 'bolt', finish: 'nonfoil', qty: 2, kind: 'collection' },
      { oracleId: 'bolt', finish: 'nonfoil', qty: 3, printingId: 'bolt-2xm', kind: 'collection' },
      { oracleId: 'ring', finish: 'foil', qty: 1, kind: 'collection' },
    ], 'add');
    const owned = await db.owned.toArray();
    expect(owned.find((o) => o.oracleId === 'bolt')).toMatchObject({ qty: 6, printingId: 'bolt-2xm', source: 'scan' });
    expect(owned.find((o) => o.oracleId === 'ring')).toMatchObject({ qty: 1, finish: 'foil', source: 'manual' });
    expect(owned).toHaveLength(2);
  });

  it('Ersetzen leert die Sammlung vorher', async () => {
    await db.owned.add({ oracleId: 'ring', finish: 'nonfoil', qty: 4, addedAt: 1, source: 'scan' });
    await applyCsvImport([{ oracleId: 'bolt', finish: 'foil', qty: 1, kind: 'collection' }], 'replace');
    const owned = await db.owned.toArray();
    expect(owned.map((o) => [o.oracleId, o.qty])).toEqual([['bolt', 1]]);
  });
});
