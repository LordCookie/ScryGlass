import { describe, it, expect } from 'vitest';
import { byPopularity, popularityTier, rankLabel, deckPopularity } from './popularity';
import type { Card } from './types';

const card = (oracleId: string, edhrecRank?: number, typeLine = 'Creature'): Card => ({
  oracleId, name: oracleId, normName: oracleId, manaCost: '', cmc: 0, colors: [], colorIdentity: [],
  typeLine, oracleText: '', layout: 'normal', legalities: 0, maxCopies: 1, ...(edhrecRank != null ? { edhrecRank } : {}),
});

describe('Beliebtheit (EDHREC-Rang über Scryfall)', () => {
  it('sortiert beliebte zuerst, ohne Rang ans Ende', () => {
    const list = [card('c'), card('b', 900), card('a', 12), card('d')];
    expect(list.sort(byPopularity).map((c) => c.oracleId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ordnet ein und beschriftet', () => {
    expect(popularityTier(undefined)).toBeNull();
    expect(popularityTier(3)).toBe('top');
    expect(popularityTier(1500)).toBe('beliebt');
    expect(popularityTier(9000)).toBe('selten');
    expect(rankLabel(412)).toBe('Platz 412 · beliebt');
    expect(rankLabel(12345)).toBe('Platz 12.345 · selten gespielt');
  });

  it('fasst ein Deck zusammen, ohne Standardländer', () => {
    const cards = [card('sol', 1), card('forest', 2, 'Basic Land — Forest'), card('x', 300), card('y', 5000), card('z', 20000), card('n')];
    const p = deckPopularity(cards, 2);
    expect(p.total).toBe(5);
    expect(p.ranked).toBe(4);
    expect(p.median).toBe(300);
    expect(p.most.map((c) => c.oracleId)).toEqual(['sol', 'x']);
    expect(p.least.map((c) => c.oracleId)).toEqual(['z', 'y']);
  });
});
