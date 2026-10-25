import { describe, it, expect } from 'vitest';
import {
  isTokenCard, isTokenLayout, tokenSetCandidates, tokenNameKeys, buildTokenNameIndex, matchTokenName, tokenOcrSignal, artScore,
} from './tokens';

describe('Token-Erkennung am Layout', () => {
  it('token, double_faced_token und emblem sind Tokens, Karten nicht', () => {
    expect(isTokenLayout('token')).toBe(true);
    expect(isTokenLayout('double_faced_token')).toBe(true);
    expect(isTokenLayout('emblem')).toBe(true);
    expect(isTokenLayout('normal')).toBe(false);
    expect(isTokenLayout('transform')).toBe(false);
    expect(isTokenLayout(undefined)).toBe(false);
    expect(isTokenCard({ layout: 'token' })).toBe(true);
    expect(isTokenCard(undefined)).toBe(false);
  });

  it('aufgedrucktes Set → Token-Set zuerst, dann das Set selbst', () => {
    expect(tokenSetCandidates('BLB')).toEqual(['tblb', 'blb']);
  });
});

describe('Token-Namen', () => {
  const index = buildTokenNameIndex([
    { oracleId: 'mouse-red', name: 'Mouse' },
    { oracleId: 'mouse-white', name: 'Mouse' },
    { oracleId: 'soldier', name: 'Soldier' },
    { oracleId: 'treasure-clue', name: 'Treasure // Clue' },
    { oracleId: 'treasure', name: 'Treasure' },
  ]);

  it('Namen je Seite eines doppelseitigen Tokens', () => {
    expect(tokenNameKeys('Treasure // Clue')).toEqual(['treasure clue', 'treasure', 'clue']);
    expect(index.get('treasure')).toEqual(['treasure-clue', 'treasure']);
  });

  it('exakt: alle Oracles des Namens, Score 1', () => {
    expect(matchTokenName('Mouse', index)).toEqual([
      { oracleId: 'mouse-red', score: 1 },
      { oracleId: 'mouse-white', score: 1 },
    ]);
  });

  it('unscharf: der ähnlichste Name, zu weit weg = nichts', () => {
    const hits = matchTokenName('Soldjer', index);
    expect(hits.map((h) => h.oracleId)).toEqual(['soldier']);
    expect(hits[0].score).toBeGreaterThanOrEqual(0.75);
    expect(matchTokenName('Lightning Bolt', index)).toEqual([]);
    expect(matchTokenName('Mo', index)).toEqual([]);
  });

  it('OCR-Signal: der Bildtreffer steht vorn, mehrere Namen = mehrdeutig', () => {
    const hits = matchTokenName('Mouse', index);
    expect(tokenOcrSignal(hits, 'mouse-white')).toEqual({ oracleId: 'mouse-white', score: 1, ambiguous: true });
    expect(tokenOcrSignal(hits, 'soldier').oracleId).toBe('mouse-red');
    expect(tokenOcrSignal(matchTokenName('Soldier', index)).ambiguous).toBe(false);
    expect(tokenOcrSignal([])).toEqual({ score: 0, ambiguous: false });
  });

  it('Artwork-Sicherheit aus dem Bildabstand, begrenzt', () => {
    expect(artScore(0)).toBe(0.95);
    expect(artScore(64)).toBe(0.5);
    expect(artScore(200)).toBe(0.3);
  });
});
