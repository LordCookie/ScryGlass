import { describe, it, expect } from 'vitest';
import { computeSetProgress } from './setProgress';

describe('computeSetProgress', () => {
  const setCards = new Map<string, Set<string>>([
    ['fra', new Set(['a', 'b', 'c', 'd'])],
    ['dmu', new Set(['a', 'x'])],
    ['sld', new Set(['y'])],
  ]);

  it('zählt verschiedene Karten je Set, egal in welcher Ausgabe', () => {
    const p = computeSetProgress(new Set(['a', 'b', 'x']), setCards);
    expect(p).toEqual([
      { set: 'dmu', have: 2, total: 2, ratio: 1 },
      { set: 'fra', have: 2, total: 4, ratio: 0.5 },
    ]);
  });

  it('Sets ohne eigene Karte fallen weg; meiste Karten zuerst', () => {
    const p = computeSetProgress(new Set(['a', 'b', 'c']), setCards);
    expect(p.map((x) => x.set)).toEqual(['fra', 'dmu']);
    expect(computeSetProgress(new Set(), setCards)).toEqual([]);
  });
});
