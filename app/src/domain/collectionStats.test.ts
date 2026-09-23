import { describe, it, expect } from 'vitest';
import { summarizeCollection } from './collectionStats';
import type { FilterRow } from './collectionFilter';
import type { Card, Finish } from './types';

function row(oracleId: string, card: Partial<Card>, qty: number, finish: Finish = 'nonfoil', set?: string): FilterRow {
  return {
    card: {
      oracleId, name: oracleId, normName: oracleId, manaCost: '', cmc: 0, colors: [], colorIdentity: [],
      typeLine: '', oracleText: '', layout: 'normal', legalities: 0, maxCopies: 4, ...card,
    },
    owned: { oracleId, finish, qty, addedAt: 0, source: 'manual' },
    set,
  };
}

describe('summarizeCollection', () => {
  const rows: FilterRow[] = [
    row('bolt', { typeLine: 'Instant', cmc: 1, colors: ['R'] }, 3, 'nonfoil', 'm10'),
    row('bolt', { typeLine: 'Instant', cmc: 1, colors: ['R'] }, 1, 'foil', 'm10'), // gleiche Karte, Foil
    row('forest', { typeLine: 'Basic Land — Forest' }, 10, 'nonfoil', 'dmu'),
    row('golem', { typeLine: 'Artifact Creature — Golem', cmc: 3 }, 2), // Set unbekannt
  ];
  const s = summarizeCollection(rows);

  it('zählt Karten, verschiedene und Foils', () => {
    expect(s.total).toBe(16);
    expect(s.distinct).toBe(3);
    expect(s.foil).toBe(1);
  });

  it('sortiert Sets nach Anzahl und zählt nur bekannte Ausgaben', () => {
    expect(s.sets).toEqual([{ set: 'dmu', qty: 10 }, { set: 'm10', qty: 4 }]);
    expect(s.knownSetQty).toBe(14);
  });

  it('nutzt die Deck-Statistik für Typen, Kurve und Farben (qty-gewichtet)', () => {
    expect(s.stats.lands).toBe(10);
    expect(s.stats.types).toMatchObject({ Instant: 4, Land: 10, Creature: 2 });
    expect(s.stats.manaCurve[1]).toBe(4);
    expect(s.stats.manaCurve[3]).toBe(2);
    expect(s.stats.colors.R).toBe(4);
    expect(s.stats.colors.C).toBe(2); // farbloser Golem, Länder zählen nicht
  });

  it('leere Sammlung', () => {
    const e = summarizeCollection([]);
    expect(e).toMatchObject({ total: 0, distinct: 0, foil: 0, knownSetQty: 0, sets: [] });
  });
});
