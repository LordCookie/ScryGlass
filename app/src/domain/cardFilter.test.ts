import { describe, it, expect } from 'vitest';
import {
  matchesCardFilter, hasCardFilter, EMPTY_CARD_FILTER, matchesColors, toggleColor,
  typeLineMatches, germanTypeWords, collectSubtypes,
} from './cardFilter';
import { LEGALITY_FORMATS, type Card } from './types';

const legalIn = (...formats: string[]) =>
  formats.reduce((m, f) => m | (1 << LEGALITY_FORMATS.indexOf(f as (typeof LEGALITY_FORMATS)[number])), 0);

function card(p: Partial<Card>): Card {
  return {
    oracleId: 'o', name: 'X', normName: 'x', manaCost: '', cmc: 0, colors: [], colorIdentity: [],
    typeLine: '', oracleText: '', layout: 'normal', legalities: 0, maxCopies: 4, ...p,
  };
}

const bolt = card({
  name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1, colorIdentity: ['R'],
  oracleText: 'Lightning Bolt deals 3 damage to any target.', legalities: legalIn('modern', 'legacy', 'commander'),
});
const golem = card({ name: 'Golem', typeLine: 'Artifact Creature — Golem', cmc: 8, legalities: legalIn('commander') });
const krenko = card({
  name: 'Krenko, Mob Boss', typeLine: 'Legendary Creature — Goblin Warrior', cmc: 4, colorIdentity: ['R'],
  oracleText: '{T}: Create X 1/1 red Goblin creature tokens.',
});

describe('matchesCardFilter', () => {
  it('ohne Filter passt alles', () => {
    expect(matchesCardFilter(bolt, EMPTY_CARD_FILTER)).toBe(true);
    expect(hasCardFilter(EMPTY_CARD_FILTER)).toBe(false);
  });

  it('Farbe inkl. farblos', () => {
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, colors: ['R'] })).toBe(true);
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, colors: ['C'] })).toBe(false);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, colors: ['C'] })).toBe(true);
  });

  it('Typ, Manawert (7+) und Format', () => {
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, type: 'Creature' })).toBe(true);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, cmc: 7 })).toBe(true);
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(true);
    expect(matchesCardFilter(golem, { ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(false);
    expect(hasCardFilter({ ...EMPTY_CARD_FILTER, format: 'modern' })).toBe(true);
  });

  it('Regeltext: alle Wörter, egal in welcher Reihenfolge', () => {
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, text: 'damage target' })).toBe(true);
    expect(matchesCardFilter(bolt, { ...EMPTY_CARD_FILTER, text: 'damage flying' })).toBe(false);
    expect(hasCardFilter({ ...EMPTY_CARD_FILTER, text: '  ' })).toBe(false);
  });

  it('Typzeile: Kreaturentyp, mehrere Wörter, deutsche Typwörter', () => {
    expect(matchesCardFilter(krenko, { ...EMPTY_CARD_FILTER, typeLine: 'goblin' })).toBe(true);
    expect(matchesCardFilter(krenko, { ...EMPTY_CARD_FILTER, typeLine: 'Legendary Warrior' })).toBe(true);
    expect(matchesCardFilter(krenko, { ...EMPTY_CARD_FILTER, typeLine: 'elf' })).toBe(false);
    expect(typeLineMatches(krenko.typeLine, 'legendäre kobold')).toBe(false); // Beugung wird nicht erraten
    expect(typeLineMatches(krenko.typeLine, 'legendär kobold kreatur')).toBe(true);
  });
});

describe('matchesColors (mehrere Farben)', () => {
  const izzet = ['U', 'R'];
  it('enthält: alle gewählten, weitere erlaubt', () => {
    expect(matchesColors(['U', 'R', 'G'], izzet, 'include')).toBe(true);
    expect(matchesColors(['R'], izzet, 'include')).toBe(false);
  });
  it('genau: nur diese Farben', () => {
    expect(matchesColors(['R', 'U'], izzet, 'exact')).toBe(true);
    expect(matchesColors(['U', 'R', 'G'], izzet, 'exact')).toBe(false);
  });
  it('höchstens: passt ins Deck (inkl. einfarbig und farblos)', () => {
    expect(matchesColors(['R'], izzet, 'within')).toBe(true);
    expect(matchesColors([], izzet, 'within')).toBe(true);
    expect(matchesColors(['G'], izzet, 'within')).toBe(false);
  });
  it('farblos schließt Farben aus', () => {
    expect(matchesColors([], ['C'], 'include')).toBe(true);
    expect(matchesColors(['R'], ['C'], 'within')).toBe(false);
  });
});

describe('toggleColor', () => {
  it('an/aus in WUBRG-Reihenfolge, farblos exklusiv', () => {
    expect(toggleColor([], 'R')).toEqual(['R']);
    expect(toggleColor(['R'], 'U')).toEqual(['U', 'R']);
    expect(toggleColor(['U', 'R'], 'U')).toEqual(['R']);
    expect(toggleColor(['U', 'R'], 'C')).toEqual(['C']);
    expect(toggleColor(['C'], 'G')).toEqual(['G']);
    expect(toggleColor(['C'], 'C')).toEqual([]);
  });
});

describe('Typ-Hilfen', () => {
  it('germanTypeWords liefert deutsche Entsprechungen für die Volltextsuche', () => {
    const w = germanTypeWords(krenko.typeLine).split(' ');
    expect(w).toContain('kreatur');
    expect(w).toContain('kobold');
    expect(w).toContain('krieger');
    expect(w).toContain('legendär');
  });
  it('collectSubtypes sammelt Untertypen, auch von Doppelkarten', () => {
    expect(collectSubtypes([
      krenko.typeLine,
      'Instant',
      'Creature — Human Wizard // Creature — Human Insect',
      'Artifact — Equipment',
    ])).toEqual(['Equipment', 'Goblin', 'Human', 'Insect', 'Warrior', 'Wizard']);
  });
});
