import { describe, it, expect } from 'vitest';
import type { Owned, Deck } from './types';
import {
  serializeCollection,
  parseCollection,
  CollectionImportError,
  COLLECTION_SCHEMA,
} from './collectionIo';
import { toMoxfieldCsv } from './collectionCsv';

const owned: Owned[] = [
  { id: 9, oracleId: 'o2', finish: 'foil', qty: 1, addedAt: 100, source: 'scan' },
  { id: 1, oracleId: 'o1', finish: 'nonfoil', qty: 4, addedAt: 50, source: 'manual' },
];
const decks: Deck[] = [
  { id: 3, name: 'Burn', format: 'modern', cards: [{ oracleId: 'o1', qty: 4 }], sideboard: [], updatedAt: 10 },
];

describe('collectionIo', () => {
  it('round-trip verlustfrei und deterministisch sortiert', () => {
    const json = serializeCollection(owned, decks, 12345);
    const back = parseCollection(json);
    expect(back.schema).toBe(COLLECTION_SCHEMA);
    expect(back.exportedAt).toBe(12345);
    // sortiert nach oracleId; ids entfernt
    expect(back.owned.map((o) => o.oracleId)).toEqual(['o1', 'o2']);
    expect(back.owned[0]).not.toHaveProperty('id');
    expect(back.decks[0].name).toBe('Burn');
  });

  it('Token-Zahl kommt mit; ältere Backups ohne Feld bleiben gültig', () => {
    expect(parseCollection(serializeCollection(owned, decks, 1, 12)).tokens).toBe(12);
    const old = parseCollection(serializeCollection(owned, decks, 1));
    expect(old.tokens).toBeUndefined();
    expect(old.owned).toHaveLength(2);
  });

  it('Fertigdecks kommen mit (ohne Deck-ID); kaputte fallen weg; Quelle „precon" ist gültig', () => {
    const items = [{ oracleId: 'o1', finish: 'foil' as const, printingId: 'p1', qty: 1 }];
    const precons = [
      { id: 4, key: 'B_X', name: 'B', set: 'x', addedAt: 2, copies: 1, deckId: 9, items },
      { id: 3, key: 'A_X', name: 'A', set: 'x', addedAt: 1, copies: 2, items },
    ];
    const withPrecon = [...owned, { ...owned[0], oracleId: 'o9', source: 'precon' as const }];
    const back = parseCollection(serializeCollection(withPrecon, decks, 1, undefined, precons));
    expect(back.owned).toHaveLength(3);
    expect(back.precons?.map((p) => p.key)).toEqual(['A_X', 'B_X']);
    expect(back.precons?.[1]).not.toHaveProperty('deckId');
    expect(back.precons?.[1]).not.toHaveProperty('id');
    const broken = JSON.parse(serializeCollection(owned, decks, 1, undefined, precons));
    broken.precons[0].items = [{ oracleId: 1 }];
    expect(parseCollection(JSON.stringify(broken)).precons?.map((p) => p.key)).toEqual(['B_X']);
  });

  it('byte-stabil (zweimal serialisieren = identisch)', () => {
    expect(serializeCollection(owned, decks, 1)).toBe(serializeCollection([...owned].reverse(), decks, 1));
  });

  it('wirft bei fremdem Schema', () => {
    expect(() => parseCollection('{"schema":"foreign"}')).toThrow(CollectionImportError);
  });

  it('wirft bei kaputtem JSON', () => {
    expect(() => parseCollection('{nope')).toThrow(CollectionImportError);
  });

  it('überspringt kaputte Decks, ohne owned zu blockieren', () => {
    const json = JSON.stringify({
      schema: COLLECTION_SCHEMA,
      version: 1,
      exportedAt: 0,
      owned: [{ oracleId: 'x', finish: 'nonfoil', qty: 1, addedAt: 0, source: 'scan' }],
      decks: [{ broken: true }],
    });
    const back = parseCollection(json);
    expect(back.owned).toHaveLength(1);
    expect(back.decks).toHaveLength(0);
  });
});

describe('toMoxfieldCsv', () => {
  it('erzeugt Header + Zeilen, Foil-Spalte korrekt', () => {
    const csv = toMoxfieldCsv([
      { name: 'Lightning Bolt', qty: 4, finish: 'nonfoil', lang: 'en', setCode: 'lea', collectorNumber: '161' },
      { name: 'Sol Ring', qty: 1, finish: 'foil', lang: 'en' },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('Count,Name,Edition,Condition,Language,Foil,Collector Number');
    // sortiert nach Name: Lightning Bolt zuerst
    expect(lines[1]).toBe('4,Lightning Bolt,lea,NM,en,,161');
    expect(lines[2]).toBe('1,Sol Ring,,NM,en,foil,');
  });

  it('escaped Kommata/Anführungszeichen im Namen', () => {
    const csv = toMoxfieldCsv([{ name: 'Krenko, Mob Boss', qty: 1, finish: 'nonfoil', lang: 'de' }]);
    expect(csv).toContain('"Krenko, Mob Boss"');
  });
});
