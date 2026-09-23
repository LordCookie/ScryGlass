import { describe, it, expect } from 'vitest';
import { matchesFilter, extraFilterCount, cmcBucket, EMPTY_FILTER, type FilterRow } from './collectionFilter';
import type { Card, Owned } from './types';

function row(card: Partial<Card>, owned: Partial<Owned> = {}, set?: string): FilterRow {
  return {
    card: {
      oracleId: 'o', name: 'X', normName: 'x', manaCost: '', cmc: 0, colors: [], colorIdentity: [],
      typeLine: '', oracleText: '', layout: 'normal', legalities: 0, maxCopies: 4, ...card,
    },
    owned: { oracleId: 'o', finish: 'nonfoil', qty: 1, addedAt: 0, source: 'manual', ...owned },
    set,
  };
}

const golem = row({ name: 'Steel Golem', typeLine: 'Artifact Creature — Golem', cmc: 3, colorIdentity: [] }, {}, 'dmu');
const bolt = row({ name: 'Lightning Bolt', typeLine: 'Instant', oracleText: 'deals 3 damage', cmc: 1, colorIdentity: ['R'] }, { finish: 'foil' });
const titan = row({ name: 'Big Titan', typeLine: 'Creature — Giant', cmc: 9, colorIdentity: ['G'] });

describe('matchesFilter', () => {
  it('ohne Filter passt alles', () => {
    for (const r of [golem, bolt, titan]) expect(matchesFilter(r, EMPTY_FILTER)).toBe(true);
  });

  it('Suche trifft Name, Typ und Regeltext', () => {
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, query: 'damage' })).toBe(true);
    expect(matchesFilter(golem, { ...EMPTY_FILTER, query: 'golem' })).toBe(true);
    expect(matchesFilter(titan, { ...EMPTY_FILTER, query: 'damage' })).toBe(false);
  });

  it('Farbe C = farblos', () => {
    expect(matchesFilter(golem, { ...EMPTY_FILTER, color: 'C' })).toBe(true);
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, color: 'C' })).toBe(false);
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, color: 'R' })).toBe(true);
  });

  it('Typ „Kreatur" trifft auch Artefaktkreaturen', () => {
    const f = { ...EMPTY_FILTER, type: 'Creature' };
    expect(matchesFilter(golem, f)).toBe(true);
    expect(matchesFilter(titan, f)).toBe(true);
    expect(matchesFilter(bolt, f)).toBe(false);
  });

  it('Manawert 7 heißt „7 oder mehr"', () => {
    expect(matchesFilter(titan, { ...EMPTY_FILTER, cmc: 7 })).toBe(true);
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, cmc: 1 })).toBe(true);
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, cmc: 3 })).toBe(false);
    expect(cmcBucket(12)).toBe(7);
  });

  it('Set filtert nur Bestände mit bekannter Ausgabe', () => {
    const f = { ...EMPTY_FILTER, set: 'dmu' };
    expect(matchesFilter(golem, f)).toBe(true);
    expect(matchesFilter(bolt, f)).toBe(false); // Set unbekannt
  });

  it('Ausführung', () => {
    expect(matchesFilter(bolt, { ...EMPTY_FILTER, finish: 'foil' })).toBe(true);
    expect(matchesFilter(golem, { ...EMPTY_FILTER, finish: 'foil' })).toBe(false);
  });

  it('zählt aktive Zusatzfilter', () => {
    expect(extraFilterCount(EMPTY_FILTER)).toBe(0);
    expect(extraFilterCount({ ...EMPTY_FILTER, type: 'Land', cmc: 0, query: 'x', color: 'W' })).toBe(2);
  });
});
