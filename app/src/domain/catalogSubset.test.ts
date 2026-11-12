import { describe, it, expect } from 'vitest';
import { subsetOracleIds } from './catalogSubset';
import type { Deck } from './types';

describe('Katalog-Ausschnitt für den Big Screen', () => {
  it('Sammlung, Decks (mit beiden Commandern und Sideboard) und Fertigdecks, ohne Doppelte', () => {
    const deck: Deck = {
      name: 'D', format: 'commander', commanderId: 'cmd', partnerId: 'partner', updatedAt: 0,
      cards: [{ oracleId: 'a', qty: 1 }, { oracleId: 'b', qty: 1 }], sideboard: [{ oracleId: 'side', qty: 1 }],
    };
    const ids = subsetOracleIds(
      [{ oracleId: 'a' }, { oracleId: 'own' }],
      [deck],
      [{ items: [{ oracleId: 'pre', finish: 'nonfoil', qty: 1 }, { oracleId: 'a', finish: 'foil', qty: 1 }] }],
    );
    expect(ids).toEqual(['a', 'own', 'cmd', 'partner', 'b', 'side', 'pre']);
  });
});
