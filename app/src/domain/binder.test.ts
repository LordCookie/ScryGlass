import { describe, it, expect } from 'vitest';
import { compareCollector, colorGroup, sortBinder, setChecklist, pageCount } from './binder';

describe('Sammelordner', () => {
  it('Sammlernummern wie gedruckt', () => {
    expect(['10', '2', '10a', '1', '★5', 'S1'].sort(compareCollector)).toEqual(['1', 'S1', '2', '★5', '10', '10a']);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(19)).toBe(3);
    expect(pageCount(19, 18)).toBe(2);
  });

  it('Farbreihenfolge und Sortierungen', () => {
    const c = (name: string, colors: string[], typeLine = 'Creature') => ({ card: { name, colors, typeLine } });
    expect(colorGroup({ colors: ['U'], typeLine: 'Instant' })).toBe(1);
    expect(colorGroup({ colors: ['U', 'R'], typeLine: 'Instant' })).toBe(5);
    expect(colorGroup({ colors: [], typeLine: 'Artifact' })).toBe(6);
    expect(colorGroup({ colors: [], typeLine: 'Basic Land — Forest' })).toBe(7);
    const items = [c('Zed', ['G']), c('Ann', ['W']), c('Forest', [], 'Basic Land — Forest'), c('Bob', ['U', 'B'])];
    expect(sortBinder(items, 'farbe').map((i) => i.card.name)).toEqual(['Ann', 'Zed', 'Bob', 'Forest']);
    expect(sortBinder(items, 'name').map((i) => i.card.name)).toEqual(['Ann', 'Bob', 'Forest', 'Zed']);
    const bySet = sortBinder([
      { ...c('B', ['W']), set: 'blb', collectorNumber: '10' },
      { ...c('A', ['W']), set: 'blb', collectorNumber: '2' },
      { ...c('C', ['W']) },
      { ...c('D', ['W']), set: 'acr', collectorNumber: '99' },
    ], 'set');
    expect(bySet.map((i) => i.card.name)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('Checkliste: je Karte ein Fach, Varianten einmal, Tokens raus, eigene markiert', () => {
    const p = (scryfallId: string, oracleId: string, collectorNumber: string, lang = 'en') => ({ scryfallId, oracleId, collectorNumber, lang });
    const list = setChecklist(
      [p('p2', 'o2', '2'), p('p1-show', 'o1', '300'), p('p1', 'o1', '1'), p('p1-de', 'o1', '1', 'de'), p('tok', 'ot', 'T1'), p('p3', 'o3', '3')],
      new Set(['o1', 'o3']),
      new Set(['ot']),
      new Map([['o3', 'p3'], ['o1', 'p1-show']]),
    );
    expect(list).toEqual([
      { oracleId: 'o1', scryfallId: 'p1-show', collectorNumber: '1', owned: true },
      { oracleId: 'o2', scryfallId: 'p2', collectorNumber: '2', owned: false },
      { oracleId: 'o3', scryfallId: 'p3', collectorNumber: '3', owned: true },
    ]);
  });
});
