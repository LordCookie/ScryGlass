import { describe, it, expect } from 'vitest';
import {
  makeRng, shuffle, libraryOf, newGame, mulligan, putOnBottom, nextTurn, drawCard, toggleTable,
  hypergeom, atLeast, landDistribution, cardsSeen, chanceByTurn, HAND_SIZE,
} from './playtest';

const DECK = [
  { oracleId: 'forest', qty: 37 },
  { oracleId: 'elf', qty: 4 },
  { oracleId: 'growth', qty: 58 },
];

describe('Probehand: Spielablauf', () => {
  it('Zufall mit Startwert ist wiederholbar, Mischen verliert nichts', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6], makeRng(7));
    const b = shuffle([1, 2, 3, 4, 5, 6], makeRng(7));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(libraryOf(DECK)).toHaveLength(99);
    expect(new Set(libraryOf(DECK).map((c) => c.uid)).size).toBe(99);
  });

  it('neues Spiel: 7 auf der Hand, Rest in der Bibliothek', () => {
    const s = newGame(DECK, makeRng(1));
    expect(s.hand).toHaveLength(HAND_SIZE);
    expect(s.library).toHaveLength(92);
    expect(s.turn).toBe(0);
  });

  it('London-Mulligan: wieder 7, dann so viele unter die Bibliothek wie Mulligans', () => {
    const rng = makeRng(2);
    let s = newGame(DECK, rng);
    s = toggleTable(s, s.hand[0].uid); // etwas auf dem Tisch kommt beim Mulligan zurück
    s = mulligan(s, rng);
    s = mulligan(s, rng);
    expect(s.hand).toHaveLength(7);
    expect(s.table).toHaveLength(0);
    expect(s.toBottom).toBe(2);
    expect(nextTurn(s)).toBe(s); // erst unterlegen
    const bottom = s.hand[3];
    s = putOnBottom(s, bottom.uid);
    s = putOnBottom(s, s.hand[0].uid);
    expect(s.hand).toHaveLength(5);
    expect(s.toBottom).toBe(0);
    expect(s.library[s.library.length - 2]).toEqual(bottom);
    expect(s.library.length + s.hand.length).toBe(99);
  });

  it('Commander: der erste Mulligan ist frei', () => {
    const rng = makeRng(3);
    const s = mulligan(newGame(DECK, rng, { freeMulligan: true }), rng);
    expect(s.toBottom).toBe(0);
    expect(mulligan(s, rng).toBottom).toBe(1);
  });

  it('Zug 1 auf dem Play ohne Karte, auf dem Draw mit', () => {
    const play = newGame(DECK, makeRng(4));
    const t1 = nextTurn(play);
    expect(t1.turn).toBe(1);
    expect(t1.hand).toHaveLength(7);
    expect(nextTurn(t1).hand).toHaveLength(8);
    const draw = newGame(DECK, makeRng(4), { onDraw: true });
    expect(nextTurn(draw).hand).toHaveLength(8);
    expect(nextTurn(draw).hand[7]).toEqual(draw.library[0]);
  });

  it('Tisch hin und zurück, leere Bibliothek zieht nichts', () => {
    let s = newGame([{ oracleId: 'x', qty: 7 }], makeRng(5));
    const uid = s.hand[2].uid;
    s = toggleTable(s, uid);
    expect(s.table.map((c) => c.uid)).toEqual([uid]);
    expect(s.hand).toHaveLength(6);
    s = toggleTable(s, uid);
    expect(s.hand).toHaveLength(7);
    expect(drawCard(s)).toBe(s);
  });
});

describe('Probehand: Rechnung', () => {
  it('hypergeometrisch: bekannte Werte', () => {
    // 60 Karten, 4 Kopien, 7 gezogen: P(mind. eine) ≈ 39,95 %
    expect(atLeast(60, 4, 7, 1)).toBeCloseTo(0.3995, 3);
    // 99 Karten, 37 Länder, genau 3 in 7: ≈ 29,1 % (mit Python nachgerechnet)
    expect(hypergeom(99, 37, 7, 3)).toBeCloseTo(0.29116, 4);
    const dist = landDistribution(99, 37);
    expect(dist).toHaveLength(8);
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(hypergeom(10, 2, 3, 3)).toBe(0);
  });

  it('Karte bis Zug N', () => {
    expect(cardsSeen(0, false)).toBe(7);
    expect(cardsSeen(1, false)).toBe(7);
    expect(cardsSeen(1, true)).toBe(8);
    expect(cardsSeen(3, false)).toBe(9);
    // Singleton im 99er-Deck: bis Zug 1 auf dem Play 7/99
    expect(chanceByTurn(99, 1, 1, false)).toBeCloseTo(7 / 99, 10);
    expect(chanceByTurn(99, 1, 3, true)).toBeCloseTo(10 / 99, 10);
    expect(chanceByTurn(5, 1, 3, true)).toBe(1);
  });
});
