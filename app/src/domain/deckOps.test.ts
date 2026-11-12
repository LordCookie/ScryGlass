import { describe, it, expect } from 'vitest';
import { applyDeckOp, isDeckOp, type DeckOp } from './deckOps';
import type { Deck } from './types';

const base: Deck = {
  id: 1, name: 'Burn', format: 'modern', cards: [{ oracleId: 'bolt', qty: 3 }], sideboard: [], updatedAt: 1,
};

describe('Deck-Schritte', () => {
  it('Karten zählen hoch und runter, bei 0 weg', () => {
    let d = applyDeckOp(base, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 }, 5);
    expect(d.cards).toEqual([{ oracleId: 'bolt', qty: 4 }]);
    expect(d.updatedAt).toBe(5);
    d = applyDeckOp(d, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: -4 });
    expect(d.cards).toEqual([]);
    d = applyDeckOp(d, { kind: 'adjust', list: 'sideboard', oracleId: 'rip', delta: 2 });
    expect(d.sideboard).toEqual([{ oracleId: 'rip', qty: 2 }]);
    expect(applyDeckOp(d, { kind: 'adjust', list: 'cards', oracleId: 'neu', delta: -1 }).cards).toEqual([]);
    expect(base.cards).toEqual([{ oracleId: 'bolt', qty: 3 }]); // unverändert
  });

  it('zwei Schritte von zwei Geräten gehen beide durch', () => {
    // Handy +1 Bolt, Browser +1 Ponder — beide auf den aktuellen Stand angewendet.
    const a = applyDeckOp(base, { kind: 'adjust', list: 'cards', oracleId: 'bolt', delta: 1 });
    const b = applyDeckOp(a, { kind: 'adjust', list: 'cards', oracleId: 'ponder', delta: 1 });
    expect(b.cards).toEqual([{ oracleId: 'bolt', qty: 4 }, { oracleId: 'ponder', qty: 1 }]);
  });

  it('Name, Format, Commander, Listen ersetzen', () => {
    expect(applyDeckOp(base, { kind: 'rename', name: 'Brennen' }).name).toBe('Brennen');
    expect(applyDeckOp(base, { kind: 'format', format: 'commander' }).format).toBe('commander');
    const c = applyDeckOp(base, { kind: 'commander', oracleId: 'kiki' });
    expect(c.commanderId).toBe('kiki');
    expect(applyDeckOp(c, { kind: 'commander', oracleId: null })).not.toHaveProperty('commanderId');
    const r = applyDeckOp(base, { kind: 'replaceLists', cards: [{ oracleId: 'a', qty: 2 }, { oracleId: 'b', qty: 0 }], sideboard: [] });
    expect(r.cards).toEqual([{ oracleId: 'a', qty: 2 }]);
  });

  it('zwei Commander: setzen, und beim Ausschalten wandert der zweite ins Hauptdeck', () => {
    const cmd: Deck = { ...base, format: 'commander', commanderId: 'tana' };
    const on = applyDeckOp(cmd, { kind: 'twoCommanders', on: true });
    expect(on.twoCommanders).toBe(true);
    const p = applyDeckOp(on, { kind: 'partner', oracleId: 'tymna' });
    expect(p.partnerId).toBe('tymna');
    const off = applyDeckOp(p, { kind: 'twoCommanders', on: false });
    expect(off).not.toHaveProperty('partnerId');
    expect(off).not.toHaveProperty('twoCommanders');
    expect(off.cards).toEqual([{ oracleId: 'bolt', qty: 3 }, { oracleId: 'tymna', qty: 1 }]);
    expect(off.commanderId).toBe('tana');
    // Partner setzen schaltet „Zwei Commander" mit ein; entfernen lässt den Platz stehen.
    const direct = applyDeckOp(cmd, { kind: 'partner', oracleId: 'tymna' });
    expect(direct.twoCommanders).toBe(true);
    const cleared = applyDeckOp(direct, { kind: 'partner', oracleId: null });
    expect(cleared).not.toHaveProperty('partnerId');
    expect(cleared.twoCommanders).toBe(true);
    expect(isDeckOp({ kind: 'partner', oracleId: null })).toBe(true);
    expect(isDeckOp({ kind: 'twoCommanders', on: 'ja' })).toBe(false);
  });

  it('prüft Schritte von außen', () => {
    const ok: DeckOp[] = [
      { kind: 'adjust', list: 'cards', oracleId: 'x', delta: 1 },
      { kind: 'commander', oracleId: null },
      { kind: 'replaceLists', cards: [{ oracleId: 'a', qty: 1 }], sideboard: [] },
    ];
    for (const op of ok) expect(isDeckOp(op)).toBe(true);
    expect(isDeckOp({ kind: 'adjust', list: 'maybe', oracleId: 'x', delta: 1 })).toBe(false);
    expect(isDeckOp({ kind: 'drop table' })).toBe(false);
    expect(isDeckOp({ kind: 'replaceLists', cards: [{ oracleId: 1 }], sideboard: [] })).toBe(false);
    expect(isDeckOp(null)).toBe(false);
  });
});
