import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, getMeta } from '../db/db';
import {
  syncOnStartup,
  importCatalog,
  fetchRemoteVersion,
  getLocalCatalogVersion,
  type CatalogVersion,
} from './catalog';

const VERSION: CatalogVersion = {
  catalogVersion: '20260101000000',
  builtAt: '2026-01-01T00:00:00+00:00',
  scryfallBulkDate: '2026-01-01',
  counts: { cards: 2, printings: 2, names: 3, trigrams: 2 },
};

const FILES: Record<string, string> = {
  'version.json': JSON.stringify(VERSION),
  'cards.ndjson':
    '{"oracleId":"o1","name":"Lightning Bolt","normName":"lightning bolt","manaCost":"{R}","cmc":1,"colors":["R"],"colorIdentity":["R"],"typeLine":"Instant","oracleText":"","layout":"normal","legalities":124,"maxCopies":4}\n' +
    '{"oracleId":"o2","name":"Forest","normName":"forest","manaCost":"","cmc":0,"colors":[],"colorIdentity":["G"],"typeLine":"Basic Land","oracleText":"","layout":"normal","legalities":255,"maxCopies":99}\n',
  'printings.ndjson':
    '{"scryfallId":"p1","oracleId":"o1","set":"lea","collectorNumber":"161","lang":"en","finishes":["nonfoil"]}\n' +
    '{"scryfallId":"p2","oracleId":"o2","set":"znr","collectorNumber":"280","lang":"en","finishes":["nonfoil"]}\n',
  'names.ndjson':
    '{"normName":"lightning bolt","oracleId":"o1","lang":"en"}\n' +
    '{"normName":"blitzschlag","oracleId":"o1","lang":"de"}\n' +
    '{"normName":"forest","oracleId":"o2","lang":"en"}\n',
  'trigrams.ndjson':
    '{"trigram":"lig","oracleIds":["o1"]}\n{"trigram":"for","oracleIds":["o2"]}\n',
};

function streamResponse(text: string): Response {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function mockFetch(overrides: Partial<Record<string, () => Response | Promise<Response>>> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(FILES).find((f) => url.endsWith(f));
    if (key && overrides[key]) return overrides[key]!();
    if (key) {
      if (key === 'version.json') return new Response(FILES[key], { status: 200 });
      return streamResponse(FILES[key]);
    }
    return new Response('not found', { status: 404 });
  });
}

async function clearAll() {
  await Promise.all([
    db.cards.clear(),
    db.printings.clear(),
    db.names.clear(),
    db.trigrams.clear(),
    db.meta.clear(),
    db.owned.clear(),
  ]);
}

beforeEach(clearAll);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchRemoteVersion', () => {
  it('liefert die Version', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const v = await fetchRemoteVersion('/catalog');
    expect(v?.catalogVersion).toBe(VERSION.catalogVersion);
  });

  it('liefert null bei Netzfehler (stiller Offline-Fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchRemoteVersion('/catalog')).toBeNull();
  });
});

describe('importCatalog', () => {
  it('importiert alle vier Tabellen und meldet Fortschritt', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const phases: string[] = [];
    await importCatalog(VERSION, '/catalog', (p) => phases.push(p.phase));

    expect(await db.cards.count()).toBe(2);
    expect(await db.printings.count()).toBe(2);
    expect(await db.names.count()).toBe(3);
    expect(await db.trigrams.count()).toBe(2);
    // catalogVersion erst am Ende gesetzt (abbruchsicher).
    expect(await getLocalCatalogVersion()).toBe(VERSION.catalogVersion);
    expect(new Set(phases)).toEqual(new Set(['cards', 'printings', 'names', 'trigrams']));
  });

  it('ist abbruchsicher: bricht eine Phase ab, bleibt catalogVersion ungesetzt', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ 'names.ndjson': () => new Response('boom', { status: 500 }) }),
    );
    await expect(importCatalog(VERSION, '/catalog')).rejects.toThrow();
    expect(await getLocalCatalogVersion()).toBeUndefined();
  });
});

describe('syncOnStartup (§ 4)', () => {
  it('lokal fehlt -> Vollimport (Pflicht)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const r = await syncOnStartup({ base: '/catalog' });
    expect(r.status).toBe('imported');
    expect(await db.cards.count()).toBe(2);
  });

  it('remote neuer -> update-available (nicht erzwingen)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await importCatalog(VERSION, '/catalog'); // lokal = VERSION
    const newer = { ...VERSION, catalogVersion: '20270101000000' };
    vi.stubGlobal('fetch', mockFetch({ 'version.json': () => new Response(JSON.stringify(newer), { status: 200 }) }));
    const r = await syncOnStartup({ base: '/catalog' });
    expect(r.status).toBe('update-available');
    // owned/Katalog wurden NICHT automatisch verändert
    expect(await getMeta('catalogVersion')).toBe(VERSION.catalogVersion);
  });

  it('kein Netz + lokaler Katalog -> up-to-date (App startet offline)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await importCatalog(VERSION, '/catalog');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await syncOnStartup({ base: '/catalog' });
    expect(r.status).toBe('up-to-date');
  });

  it('kein Netz + kein Katalog -> offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await syncOnStartup({ base: '/catalog' });
    expect(r.status).toBe('offline');
  });

  it('Update lässt owned unangetastet (§ 4)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await importCatalog(VERSION, '/catalog');
    await db.owned.put({ oracleId: 'o1', finish: 'nonfoil', qty: 4, addedAt: 1, source: 'scan' });
    const newer = { ...VERSION, catalogVersion: '20270101000000' };
    await importCatalog(newer, '/catalog');
    expect(await db.owned.count()).toBe(1);
    expect((await db.owned.toArray())[0].qty).toBe(4);
  });
});
