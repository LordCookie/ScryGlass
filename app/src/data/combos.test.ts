import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/db';
import { syncCombos, loadComboIndex, loadComboNames, matchComboCards, hasComboData, invalidateComboIndex } from './combos';
import { findCombos } from '../domain/combos';

const FILE = [
  JSON.stringify({ meta: { source: 'Commander Spellbook', version: '7.3.6', timestamp: 't', count: 2 }, cards: ['kiki', 'pester', 'a'], results: ['Win the game'] }),
  JSON.stringify(['kiki-pester', [0, 1], 3, 7, [0], 'UR', 1, 300, '', 2]),
  JSON.stringify(['a-pester', [2, 1], 2, 5, [0], 'U', 0, 10, '', 2]),
].join('\n');

beforeEach(async () => {
  await Promise.all([db.meta.clear(), db.cards.clear(), db.names.clear()]);
  invalidateComboIndex();
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/catalog/combos.ndjson' ? new Response(FILE, { status: 200 }) : new Response('nope', { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('Kombo-Daten laden', () => {
  it('liest die Datei, legt sie ab und baut den Index daraus', async () => {
    expect(await syncCombos('/catalog', 'v1')).toBe('imported');
    expect(await hasComboData()).toBe(true);
    const ix = (await loadComboIndex())!;
    expect(ix.store.ids).toEqual(['kiki-pester', 'a-pester']);
    expect(findCombos(ix, new Set(['a', 'pester']), { maxMissing: 0 }).map((h) => ix.store.ids[h.i])).toEqual(['a-pester']);
  });

  it('gleicher Katalogstand → nichts zu tun; fehlende Datei → absent', async () => {
    await syncCombos('/catalog', 'v1');
    expect(await syncCombos('/catalog', 'v1')).toBe('skipped');
    expect(await syncCombos('/ohne', 'v2')).toBe('absent');
    expect(await hasComboData()).toBe(true); // alte Daten bleiben
  });

  it('Dev-Server liefert HTML statt Datei → absent statt Absturz', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })));
    expect(await syncCombos('/catalog', 'v1')).toBe('absent');
  });

  it('Kartennamen für die Suche (EN und DE)', async () => {
    await db.cards.bulkPut([
      { oracleId: 'kiki', name: 'Kiki-Jiki, Mirror Breaker', normName: 'kikijiki mirror breaker' },
      { oracleId: 'pester', name: 'Pestermite', normName: 'pestermite' },
    ] as never[]);
    await db.names.bulkPut([{ normName: 'kikijiki spiegelbrecher', oracleId: 'kiki', lang: 'de' }]);
    await syncCombos('/catalog', 'v1');
    const names = await loadComboNames((await loadComboIndex())!);
    expect(names.name.get('pester')).toBe('Pestermite');
    expect(matchComboCards(names, 'Spiegelbrecher')).toEqual(['kiki']);
    expect(matchComboCards(names, 'pest')).toEqual(['pester']);
    expect(matchComboCards(names, '  ')).toEqual([]);
  });
});
