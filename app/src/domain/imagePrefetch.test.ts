import { describe, it, expect } from 'vitest';
import { prefetchOrder, prefetchOracleIds } from './imagePrefetch';
import type { Deck } from './types';

const deck = (p: Partial<Deck>): Deck => ({ name: 'D', format: 'commander', cards: [], sideboard: [], updatedAt: 0, ...p });

describe('Vorladen der Kartenbilder', () => {
  const preview = new Map([['a', 'pa'], ['b', 'pb'], ['c', 'pc'], ['cmd', 'pcmd'], ['tok', 'ptok']]);

  it('Commander zuerst, dann neueste Decks, dann Sammlung — gewählte Ausgabe vor Vorschau, ohne Doppelte', () => {
    const decks = [
      deck({ updatedAt: 1, cards: [{ oracleId: 'c', qty: 1 }] }),
      deck({ updatedAt: 5, commanderId: 'cmd', cards: [{ oracleId: 'a', qty: 1 }, { oracleId: 'b', qty: 2 }] }),
    ];
    const owned = [{ oracleId: 'a', printingId: 'ownA' }, { oracleId: 'b' }, { oracleId: 'tok', printingId: 'artTok' }];
    expect(prefetchOrder(decks, owned, preview)).toEqual(['pcmd', 'ownA', 'pb', 'pc', 'artTok']);
  });

  it('hält sich an die Obergrenze und braucht Vorschauen nur ohne Artwork', () => {
    const owned = [{ oracleId: 'a' }, { oracleId: 'b' }, { oracleId: 'c' }];
    expect(prefetchOrder([], owned, preview, 2)).toEqual(['pa', 'pb']);
    expect(prefetchOracleIds([deck({ partnerId: 'cmd', cards: [{ oracleId: 'a', qty: 1 }] })], [{ oracleId: 'tok', printingId: 'x' }, { oracleId: 'b' }]))
      .toEqual(['cmd', 'a', 'b']);
  });
});
