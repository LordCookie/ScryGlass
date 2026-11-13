import { describe, it, expect } from 'vitest';
import { compareDecks, playedEntries } from './deckCompare';

describe('Deck-Vergleich', () => {
  const a = { commanderId: 'cmdA', cards: [{ oracleId: 'sol', qty: 1 }, { oracleId: 'forest', qty: 30 }, { oracleId: 'onlyA', qty: 1 }] };
  const b = { commanderId: 'cmdB', partnerId: 'partner', cards: [{ oracleId: 'sol', qty: 1 }, { oracleId: 'forest', qty: 20 }, { oracleId: 'onlyB', qty: 2 }] };

  it('Commander zählen mit', () => {
    expect(playedEntries(b)).toEqual([
      { oracleId: 'sol', qty: 1 }, { oracleId: 'forest', qty: 20 }, { oracleId: 'onlyB', qty: 2 },
      { oracleId: 'cmdB', qty: 1 }, { oracleId: 'partner', qty: 1 },
    ]);
  });

  it('teilt auf und findet, was für beide nicht reicht (Standardländer ausgenommen)', () => {
    const owned = new Map([['sol', 1], ['forest', 12]]);
    const r = compareDecks(a, b, owned, (id) => id === 'forest');
    expect(r.both).toEqual([{ oracleId: 'sol', a: 1, b: 1 }, { oracleId: 'forest', a: 30, b: 20 }]);
    expect(r.onlyA.map((x) => x.oracleId)).toEqual(['onlyA', 'cmdA']);
    expect(r.onlyB.map((x) => x.oracleId)).toEqual(['onlyB', 'cmdB', 'partner']);
    expect(r.short).toEqual([{ oracleId: 'sol', need: 2, have: 1 }]);
    expect(compareDecks(a, b, new Map([['sol', 2]])).short.map((s) => s.oracleId)).toEqual(['forest']);
  });
});
