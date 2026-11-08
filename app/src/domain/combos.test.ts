import { describe, it, expect } from 'vitest';
import {
  packCombos, indexCombos, findCombos, combosUsing, comboCards, comboResults, colorMask, resultLabel, spellbookUrl,
  type ComboHead, type ComboRow,
} from './combos';

// Aufbau wie pipeline/fetch_combos.py: Karten und Ergebnisse im Kopf, Zeilen per Index.
const head: ComboHead = {
  meta: { source: 'Commander Spellbook', version: '7.3.6', timestamp: 't', count: 4 },
  cards: ['kiki', 'pester', 'oracle', 'consult', 'a', 'b', 'c'],
  results: ['Win the game', 'Infinite creature tokens with haste', 'Infinite lifegain triggers'],
};
const rows: ComboRow[] = [
  ['kiki-pester', [0, 1], 3, 7, [1], 'UR', 0b01, 300, '', 2],
  ['oracle-consult', [2, 3], 4, 3, [0], 'UB', 0, 100, '{U}{U}{B}', 2],
  ['abc', [4, 5, 6], 1, -1, [2], 'W', 0, 0, '', 3],
  ['a-b', [4, 5], 2, 5, [2], 'W', 0, 50, '', 2],
];
const ix = indexCombos(packCombos(head, rows));

describe('Kombo-Speicher', () => {
  it('packt Zeilen spaltenweise und liest sie wieder aus', () => {
    expect(ix.store.ids).toEqual(['kiki-pester', 'oracle-consult', 'abc', 'a-b']);
    expect(comboCards(ix, 2)).toEqual(['a', 'b', 'c']);
    expect(comboResults(ix, 0)).toEqual(['Infinite creature tokens with haste']);
    expect([...ix.store.stars]).toEqual([3, 4, 1, 2]);
    expect(ix.store.mv[2]).toBe(-1);
    expect(ix.store.colors[0]).toBe(colorMask('UR'));
  });

  it('findet vollständige Kombos, stärkste zuerst', () => {
    const hits = findCombos(ix, new Set(['oracle', 'consult', 'a', 'b', 'kiki', 'pester']), { maxMissing: 0 });
    expect(hits.map((h) => ix.store.ids[h.i])).toEqual(['oracle-consult', 'kiki-pester', 'a-b']);
  });

  it('eine Karte fehlt: nennt sie, vollständige stehen vorn', () => {
    const hits = findCombos(ix, new Set(['a', 'b']), { maxMissing: 1 });
    expect(hits.map((h) => [ix.store.ids[h.i], h.missing])).toEqual([['a-b', []], ['abc', ['c']]]);
  });

  it('Commander-Pflicht: Kiki-Jiki zählt nur als Commander', () => {
    const deck = new Set(['kiki', 'pester']);
    expect(findCombos(ix, deck, { maxMissing: 0, commander: new Set(['kiki']) })).toHaveLength(1);
    expect(findCombos(ix, deck, { maxMissing: 0, commander: new Set(['other']) })).toHaveLength(0);
    // Sammlung ohne Commander: zählt normal
    expect(findCombos(ix, deck, { maxMissing: 0 })).toHaveLength(1);
  });

  it('Kombos mit einer Karte, nach Sternen und Beliebtheit', () => {
    expect(combosUsing(ix, ['a']).map((i) => ix.store.ids[i])).toEqual(['a-b', 'abc']);
    expect(combosUsing(ix, ['unbekannt'])).toEqual([]);
  });

  it('Ergebnisse auf Deutsch, Unbekanntes bleibt', () => {
    expect(resultLabel('Win the game')).toBe('Gewinnt das Spiel');
    expect(resultLabel('Near-infinite card draw')).toBe('Fast endlos Karten ziehen');
    expect(resultLabel('Something rare')).toBe('Something rare');
  });

  it('Link zu Commander Spellbook', () => {
    expect(spellbookUrl('742-1295')).toBe('https://commanderspellbook.com/combo/742-1295/');
  });
});
