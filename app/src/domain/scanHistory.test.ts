import { describe, it, expect } from 'vitest';
import { pushEntry, markAll, patchEntry, canUndo, HISTORY_MAX, type HistoryEntry } from './scanHistory';
import type { Card } from './types';

const card = { oracleId: 'o1', name: 'Sol Ring' } as Card;
const entry = (id: number, state: HistoryEntry['state'] = 'basket'): HistoryEntry => ({
  id, oracleId: 'o1', card, finish: 'nonfoil', method: 'bild', auto: true, at: id, state,
});

describe('scanHistory', () => {
  it('fügt neue Einträge vorne an und begrenzt die Länge', () => {
    let list: HistoryEntry[] = [];
    for (let i = 1; i <= HISTORY_MAX + 3; i++) list = pushEntry(list, entry(i));
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0].id).toBe(HISTORY_MAX + 3); // neuester zuerst
  });

  it('markiert beim Übernehmen nur die Korb-Einträge', () => {
    const list = [entry(1, 'basket'), entry(2, 'undone'), entry(3, 'basket')];
    const out = markAll(list, 'basket', 'collection');
    expect(out.map((e) => e.state)).toEqual(['collection', 'undone', 'collection']);
  });

  it('ändert gezielt einen Eintrag', () => {
    const out = patchEntry([entry(1), entry(2)], 2, { state: 'undone', logId: 7 });
    expect(out[1]).toMatchObject({ state: 'undone', logId: 7 });
    expect(out[0].state).toBe('basket');
  });

  it('erlaubt Rückgängig nur im Korb oder in der eigenen Sammlung', () => {
    expect(canUndo(entry(1, 'basket'))).toBe(true);
    expect(canUndo(entry(1, 'collection'))).toBe(true);
    expect(canUndo(entry(1, 'sent'))).toBe(false);
    expect(canUndo(entry(1, 'undone'))).toBe(false);
    expect(canUndo(entry(1, 'discarded'))).toBe(false);
  });
});
