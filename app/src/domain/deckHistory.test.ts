import { describe, it, expect } from 'vitest';
import { inverseOps, groupHistory, undoOpsFor, type DeckHistoryEntry } from './deckHistory';
import { applyDeckOp, type DeckOp } from './deckOps';
import type { Deck } from './types';

const base: Deck = {
  id: 1, name: 'Burn', format: 'commander', commanderId: 'cmd', cards: [{ oracleId: 'bolt', qty: 1 }], sideboard: [], updatedAt: 0,
};

/** Schritt anwenden und rückgängig machen → wieder der Ausgangsstand. */
function roundTrip(deck: Deck, op: DeckOp): Deck {
  const undo = inverseOps(deck, op);
  return undo.reduce((d, u) => applyDeckOp(d, u, 0), applyDeckOp(deck, op, 0));
}
const same = (a: Deck, b: Deck) => {
  const norm = (d: Deck) => ({ ...d, updatedAt: 0, cards: [...d.cards].sort((x, y) => x.oracleId.localeCompare(y.oracleId)) });
  expect(norm(a)).toEqual(norm(b));
};

describe('Deck-Verlauf: Rückgängig', () => {
  it('jeder Schritt lässt sich zurücknehmen', () => {
    const ops: DeckOp[] = [
      { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 2 },
      { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: -5 }, // mehr weg als da
      { kind: 'adjust', list: 'sideboard', oracleId: 'rip', delta: 1 },
      { kind: 'rename', name: 'Brennen' },
      { kind: 'format', format: 'modern' },
      { kind: 'commander', oracleId: 'neu' },
      { kind: 'partner', oracleId: 'tymna' },
      { kind: 'twoCommanders', on: true },
      { kind: 'replaceLists', cards: [{ oracleId: 'x', qty: 4 }], sideboard: [] },
    ];
    for (const op of ops) same(roundTrip(base, op), { ...base });
    const withPartner: Deck = { ...base, partnerId: 'tymna', twoCommanders: true };
    same(roundTrip(withPartner, { kind: 'twoCommanders', on: false }), withPartner);
    expect(inverseOps(base, { kind: 'adjust', list: 'cards', oracleId: 'nix', delta: -1 })).toEqual([]);
  });
});

describe('Deck-Verlauf: Zusammenfassung', () => {
  const e = (at: number, op: DeckOp, undo: DeckOp[] = []): DeckHistoryEntry => ({ deckId: 1, at, op, undo });
  const names: Record<string, string> = { bolt: 'Lightning Bolt', shock: 'Shock', tymna: 'Tymna' };
  const name = (id: string) => names[id] ?? id;

  it('fasst dichte Änderungen zusammen, neueste Gruppe zuerst', () => {
    const groups = groupHistory([
      e(0, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 }),
      e(60_000, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 }),
      e(120_000, { kind: 'adjust', list: 'cards', oracleId: 'shock', delta: -1 }),
      e(130_000, { kind: 'rename', name: 'Bur' }),
      e(131_000, { kind: 'rename', name: 'Burn 2' }),
      e(3_600_000, { kind: 'partner', oracleId: 'tymna' }),
      e(3_700_000, { kind: 'adjust', list: 'sideboard', oracleId: 'shock', delta: 2 }),
    ], name);
    expect(groups).toHaveLength(2);
    expect(groups[0].lines).toEqual(['Zweiter Commander: Tymna', '+2 Shock (Sideboard)']);
    expect(groups[1].lines).toEqual(['Umbenannt in „Burn 2"', '+2 Lightning Bolt', '−1 Shock']);
    expect(groupHistory([e(0, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 }), e(1, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: -1 })], name)[0].lines)
      .toEqual(['Keine Änderung unterm Strich']);
  });

  it('Rückgängig für eine Gruppe: neueste zuerst', () => {
    const u1: DeckOp = { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: -1 };
    const u2: DeckOp = { kind: 'rename', name: 'Alt' };
    const [g] = groupHistory([e(0, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 }, [u1]), e(10, { kind: 'rename', name: 'Neu' }, [u2])], name);
    expect(undoOpsFor(g)).toEqual([u2, u1]);
  });
});
