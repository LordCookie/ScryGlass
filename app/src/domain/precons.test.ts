import { describe, it, expect } from 'vitest';
import {
  parsePreconRow, preconSearchText, filterPrecons, preconBookings, deckFromPrecon, planRemoval,
  ownedCoverage, preconDeckSize, preconTypeLabel, preconMakesDeck, type PreconHead, type PreconRow, type PrintingInfo,
} from './precons';
import type { OwnedBooking, Precon } from './types';

const HEAD: PreconHead = {
  meta: { source: 'MTGJSON', count: 1 },
  printings: ['p-cmd', 'p-partner', 'p-sol', 'p-plains', 'p-disp', 'p-tok', 'p-gone', 'p-side'],
};
const ROW: PreconRow = [
  'CavalryCharge_MOC', 'Cavalry Charge', 'moc', '2023-04-21', 'commander', 'Commander Deck',
  [[0, 1, 1], [1, 1, 1]], // zwei Commander, foil
  [[2, 1, 0], [3, 30, 0], [6, 2, 0]],
  [[7, 1, 0]],
  [[4, 1, 2]], // Display-Commander, etched
  [[5, 2, 0]],
  3,
];
const PRINTINGS = new Map<string, PrintingInfo>([
  ['p-cmd', { oracleId: 'o-cmd', token: false }],
  ['p-partner', { oracleId: 'o-partner', token: false }],
  ['p-sol', { oracleId: 'o-sol', token: false }],
  ['p-plains', { oracleId: 'o-plains', token: false }],
  ['p-disp', { oracleId: 'o-cmd', token: false }], // gleiche Karte wie der Commander, anderer Druck
  ['p-tok', { oracleId: 'o-soldier', token: true }],
  ['p-side', { oracleId: 'o-side', token: false }],
]);

function precon(): Precon {
  const p = parsePreconRow(HEAD, ROW);
  return { ...p, search: preconSearchText(p, ['Sidar Jabari', 'Sidar Jabari von Zhalfir']) };
}

describe('Fertigdecks lesen', () => {
  it('Zeile → Fertigdeck mit Druck-IDs und Ausführung', () => {
    const p = precon();
    expect(p.commander).toEqual([{ p: 'p-cmd', n: 1, f: 'foil' }, { p: 'p-partner', n: 1, f: 'foil' }]);
    expect(p.extra).toEqual([{ p: 'p-disp', n: 1, f: 'etched' }]);
    expect(p.unknown).toBe(3);
    expect(preconDeckSize(p)).toBe(36);
  });

  it('unbekannte Gruppe → Andere, kaputte Einträge fallen weg', () => {
    const p = parsePreconRow(HEAD, ['x', '', '', '', 'quatsch', 'Neu', [[99, 1, 0], [2, 0, 0], [2, 2, 9]], [], [], [], [], 0]);
    expect(p.group).toBe('other');
    expect(p.name).toBe('x');
    expect(p.commander).toEqual([{ p: 'p-sol', n: 2, f: 'nonfoil' }]);
  });

  it('Typen auf Deutsch, Unbekanntes bleibt', () => {
    expect(preconTypeLabel('Theme Deck')).toBe('Themendeck');
    expect(preconTypeLabel('Brand New Thing')).toBe('Brand New Thing');
  });

  it('Suche über Name, Set und Commander (auch deutsch), Filter nach Gruppe', () => {
    const p = precon();
    const other = { ...p, key: 'b', group: 'duel' as const, search: preconSearchText({ name: 'Elves vs Goblins', set: 'evg' }) };
    expect(filterPrecons([p, other], { query: 'zhalfir' })).toEqual([p]);
    expect(filterPrecons([p, other], { query: 'MOC cavalry' })).toEqual([p]);
    expect(filterPrecons([p, other], { group: 'duel' })).toEqual([other]);
    expect(filterPrecons([p, other], { query: '  ' })).toHaveLength(2);
    expect(preconMakesDeck(p)).toBe(true);
    expect(preconMakesDeck({ group: 'secretlair' })).toBe(false);
  });
});

describe('Buchungen', () => {
  it('alle Karten mit Druck und Ausführung, unbekannte gezählt, Tokens nur auf Wunsch', () => {
    const b = preconBookings(precon(), PRINTINGS);
    expect(b.unknown).toBe(2); // p-gone ×2
    expect(b.cards).toBe(35); // 2 Commander + 1 + 30 + Sideboard 1 + Display 1
    expect(b.tokens).toBe(0);
    expect(b.items).toContainEqual({ oracleId: 'o-cmd', finish: 'foil', printingId: 'p-cmd', qty: 1 });
    expect(b.items).toContainEqual({ oracleId: 'o-cmd', finish: 'etched', printingId: 'p-disp', qty: 1 });
    const t = preconBookings(precon(), PRINTINGS, { withTokens: true, copies: 2 });
    expect(t.tokens).toBe(4);
    expect(t.items).toContainEqual({ oracleId: 'o-plains', finish: 'nonfoil', printingId: 'p-plains', qty: 60 });
  });
});

describe('Deck aus dem Fertigdeck', () => {
  it('Commander gesetzt, Partner ins Hauptdeck, Beilagen und Tokens nicht im Deck', () => {
    const { deck, extraCommanders } = deckFromPrecon(precon(), PRINTINGS, 5);
    expect(deck.format).toBe('commander');
    expect(deck.commanderId).toBe('o-cmd');
    expect(extraCommanders).toBe(1);
    expect(deck.cards).toEqual([{ oracleId: 'o-partner', qty: 1 }, { oracleId: 'o-sol', qty: 1 }, { oracleId: 'o-plains', qty: 30 }]);
    expect(deck.sideboard).toEqual([{ oracleId: 'o-side', qty: 1 }]);
    expect(deck.updatedAt).toBe(5);
  });

  it('Brawl und andere Decks', () => {
    expect(deckFromPrecon({ ...precon(), type: 'Brawl Deck' }, PRINTINGS).deck.format).toBe('brawl');
    const { deck } = deckFromPrecon({ ...precon(), group: 'starter', type: 'Theme Deck' }, PRINTINGS);
    expect(deck.format).toBe('vintage');
    expect(deck.commanderId).toBeUndefined();
    expect(deck.cards.map((c) => c.oracleId)).toContain('o-cmd');
  });
});

describe('Wieder entfernen', () => {
  const key = (b: OwnedBooking) => `${b.oracleId}|${b.finish}`;

  it('zieht ab, was da ist, und zählt den Rest als fehlend', () => {
    const items: OwnedBooking[] = [
      { oracleId: 'o-plains', finish: 'nonfoil', printingId: 'a', qty: 30 },
      { oracleId: 'o-plains', finish: 'nonfoil', printingId: 'b', qty: 5 }, // gleicher Bestand
      { oracleId: 'o-sol', finish: 'nonfoil', qty: 1 },
    ];
    const plan = planRemoval(items, key, new Map([['o-plains|nonfoil', 32]]));
    expect(plan.total).toBe(36);
    expect(plan.missing).toBe(4); // 3 Plains + Sol Ring fehlen
    expect(plan.take.map((t) => t.qty)).toEqual([30, 2]);
  });

  it('Abdeckung: je Karte höchstens so viele wie im Deck', () => {
    const cov = ownedCoverage(precon(), PRINTINGS, new Map([['o-plains', 100], ['o-sol', 1]]));
    expect(cov).toEqual({ have: 31, total: 36 });
  });
});
