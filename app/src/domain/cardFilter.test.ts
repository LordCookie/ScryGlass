import { describe, it, expect } from 'vitest';
import { matchesCardFilter, hasCardFilter, EMPTY_CARD_FILTER } from './cardFilter';
import { LEGALITY_FORMATS, type Card } from './types';

const legalIn = (...formats: string[]) =>
  formats.reduce((m, f) => m | (1 << LEGALITY_FORMATS.indexOf(f as (typeof LEGALITY_FORMATS)[number])), 0);

function card(p: Partial<Card>): Card {
  return {
    oracleId: 'o', name: 'X', normName: 'x', manaCost: '', cmc: 0, colors: [], colorIdentity: [],
    typeLine: '', oracleText: '', layout: 'normal', legalities: 0, maxCopies: 4, ...p,
  };
}

const bolt = card({ name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, colorIdentity: ['R'], legalities: legalIn('modern', 'legacy', 'commander') });
const golem = card({ name: 'Golem', typeLine: 'Artifact Creature — Golem', cmc: 8, legalities: legalIn('commander') });

describe('matchesCardFilter', () => {
  it('ohne Filter passt alles', () => {
    expect(matchesCardFilter(bolt, EMPTY_CARD_FILTER)).toBe(true);
    expect(hasCardFilter(EMPTY_CARD_FILTER)).toBe(false);
  });

  it('Farbe inkl. farblos', () => {
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, color: 'R' })).toBe(true);
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, color: 'C' })).toBe(false);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, color: 'C' })).toBe(true);
  });

  it('Typ, Manawert (7+) und Format', () => {
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, type: 'Creature' })).toBe(true);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, cmc: 7 })).toBe(true);
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(true);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(false);
    expect(hasCardFilter({ ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(true);
  });
});
