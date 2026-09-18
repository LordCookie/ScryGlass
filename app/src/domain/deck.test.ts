import { describe, it, expect } from 'vitest';
import type { Card, Deck } from './types';
import { parseDeckText, serializeDeckText } from './deckText';
import { validateDeck, canBeCommander, colorIdentityWithin } from './deckValidate';
import { computeStats, primaryType, isLand } from './deckStats';
import { computeMissing } from './deckMissing';

// Legalitäts-Bits: standard1 pioneer2 modern4 legacy8 vintage16 commander32 pauper64 brawl128
const L_MODERN = 4;
const L_COMMANDER = 32;
const L_ALL = 255;

function card(p: Partial<Card> & { oracleId: string; name: string; typeLine: string }): Card {
  return {
    normName: p.name.toLowerCase(),
    manaCost: '',
    cmc: 0,
    colors: [],
    colorIdentity: [],
    oracleText: '',
    layout: 'normal',
    legalities: 0,
    maxCopies: 4,
    ...p,
  } as Card;
}

const CARDS = new Map<string, Card>([
  ['bolt', card({ oracleId: 'bolt', name: 'Lightning Bolt', typeLine: 'Instant', colors: ['R'], colorIdentity: ['R'], cmc: 1, legalities: L_MODERN | L_COMMANDER })],
  ['forest', card({ oracleId: 'forest', name: 'Forest', typeLine: 'Basic Land — Forest', colorIdentity: ['G'], cmc: 0, maxCopies: 99, legalities: L_ALL })],
  ['sol', card({ oracleId: 'sol', name: 'Sol Ring', typeLine: 'Artifact', cmc: 1, legalities: L_COMMANDER })],
  ['counter', card({ oracleId: 'counter', name: 'Counterspell', typeLine: 'Instant', colors: ['U'], colorIdentity: ['U'], cmc: 2, legalities: L_MODERN | L_COMMANDER })],
  ['krenko', card({ oracleId: 'krenko', name: 'Krenko, Mob Boss', typeLine: 'Legendary Creature — Goblin', colors: ['R'], colorIdentity: ['R'], cmc: 4, legalities: L_COMMANDER })],
]);

// --- deckText ---------------------------------------------------------------
describe('deckText (Moxfield)', () => {
  it('parst Mengen, Set-Codes, Kommentare und Sideboard', () => {
    const txt = [
      '4 Lightning Bolt',
      '1x Sol Ring (C21) 263',
      '# ein Kommentar',
      '',
      'SIDEBOARD:',
      '2 Duress',
    ].join('\n');
    const d = parseDeckText(txt);
    expect(d.main).toEqual([
      { qty: 4, name: 'Lightning Bolt' },
      { qty: 1, name: 'Sol Ring' },
    ]);
    expect(d.sideboard).toEqual([{ qty: 2, name: 'Duress' }]);
  });

  it('fasst gleiche Karten zusammen und nimmt qty=1 als Default', () => {
    const d = parseDeckText('Sol Ring\n2 Sol Ring');
    expect(d.main).toEqual([{ qty: 3, name: 'Sol Ring' }]);
  });

  it('serialize -> parse round-trip', () => {
    const main = [{ qty: 4, name: 'Lightning Bolt' }];
    const side = [{ qty: 2, name: 'Duress' }];
    const round = parseDeckText(serializeDeckText(main, side));
    expect(round.main).toEqual(main);
    expect(round.sideboard).toEqual(side);
  });
});

// --- validate ---------------------------------------------------------------
describe('validateDeck', () => {
  it('Constructed: Kopienlimit und Legalität', () => {
    const deck: Deck = {
      name: 't', format: 'modern', cards: [{ oracleId: 'bolt', qty: 5 }], sideboard: [], updatedAt: 0,
    };
    const r = validateDeck(deck, CARDS);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('höchstens 4'))).toBe(true);
    // Deckgröße < 60
    expect(r.issues.some((i) => i.message.includes('mindestens 60'))).toBe(true);
  });

  it('Basic Land darf über 4 hinaus', () => {
    const deck: Deck = {
      name: 't', format: 'modern', cards: [{ oracleId: 'forest', qty: 20 }], sideboard: [], updatedAt: 0,
    };
    const r = validateDeck(deck, CARDS);
    expect(r.issues.some((i) => i.message.includes('höchstens'))).toBe(false);
  });

  it('Commander: Singleton, Farbidentität, Commander-Eignung', () => {
    const deck: Deck = {
      name: 'edh',
      format: 'commander',
      commanderId: 'krenko',
      cards: [
        { oracleId: 'bolt', qty: 2 }, // Singleton-Verstoß
        { oracleId: 'counter', qty: 1 }, // Farbidentität U ⊄ R
      ],
      sideboard: [],
      updatedAt: 0,
    };
    const r = validateDeck(deck, CARDS);
    expect(r.issues.some((i) => i.message.includes('Singleton'))).toBe(true);
    expect(r.issues.some((i) => i.message.includes('Farbidentität'))).toBe(true);
    expect(r.issues.some((i) => i.message.includes('genau 100'))).toBe(true);
  });

  it('Commander muss legendär sein', () => {
    const deck: Deck = {
      name: 'edh', format: 'commander', commanderId: 'bolt', cards: [], sideboard: [], updatedAt: 0,
    };
    const r = validateDeck(deck, CARDS);
    expect(r.issues.some((i) => i.message.includes('kann kein Commander'))).toBe(true);
  });

  it('canBeCommander / colorIdentityWithin', () => {
    expect(canBeCommander(CARDS.get('krenko')!)).toBe(true);
    expect(canBeCommander(CARDS.get('bolt')!)).toBe(false);
    expect(colorIdentityWithin(CARDS.get('bolt')!, ['R'])).toBe(true);
    expect(colorIdentityWithin(CARDS.get('counter')!, ['R'])).toBe(false);
  });
});

// --- stats ------------------------------------------------------------------
describe('computeStats', () => {
  it('zählt Kurve, Farben, Länder, Typen', () => {
    const entries = [
      { oracleId: 'bolt', qty: 4 },
      { oracleId: 'forest', qty: 2 },
      { oracleId: 'krenko', qty: 1 },
    ];
    const s = computeStats(entries, CARDS);
    expect(s.total).toBe(7);
    expect(s.lands).toBe(2);
    expect(s.manaCurve[1]).toBe(4); // bolt cmc1
    expect(s.manaCurve[4]).toBe(1); // krenko cmc4
    expect(s.colors.R).toBe(5); // bolt4 + krenko1
    expect(s.types['Instant']).toBe(4);
    expect(s.types['Land']).toBe(2);
    expect(s.types['Creature']).toBe(1);
  });

  it('primaryType / isLand', () => {
    expect(isLand(CARDS.get('forest')!)).toBe(true);
    expect(primaryType(CARDS.get('krenko')!)).toBe('Creature');
    expect(primaryType(CARDS.get('bolt')!)).toBe('Instant');
  });
});

// --- missing ----------------------------------------------------------------
describe('computeMissing', () => {
  it('listet nur fehlende Karten, absteigend', () => {
    const entries = [
      { oracleId: 'bolt', qty: 4 },
      { oracleId: 'forest', qty: 2 },
      { oracleId: 'krenko', qty: 1 },
    ];
    const owned = new Map<string, number>([['bolt', 2], ['forest', 5]]);
    const rows = computeMissing(entries, owned);
    expect(rows).toEqual([
      { oracleId: 'bolt', need: 4, have: 2, missing: 2 },
      { oracleId: 'krenko', need: 1, have: 0, missing: 1 },
    ]);
  });
});
