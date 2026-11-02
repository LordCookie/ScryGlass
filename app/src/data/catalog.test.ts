import 'fake-indexeddb/auto';
import { gzipSync } from 'node:zlib';
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
  it('importiert Karten, Ausgaben und Namen und meldet Fortschritt', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const phases: string[] = [];
    await importCatalog(VERSION, '/catalog', (p) => phases.push(p.phase));

    expect(await db.cards.count()).toBe(2);
    expect(await db.printings.count()).toBe(2);
    expect(await db.names.count()).toBe(3);
    // catalogVersion erst am Ende gesetzt (abbruchsicher).
    expect(await getLocalCatalogVersion()).toBe(VERSION.catalogVersion);
    expect(new Set(phases)).toEqual(new Set(['cards', 'printings', 'names']));
    // Trigramme baut der Namensindex selbst (0.2.7) — die Datei wird nicht mehr geladen.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('trigrams'))).toBe(false);
  });

  it('Update schreibt nur Neues und Geändertes', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await importCatalog(VERSION, '/catalog');

    const [bolt, forest] = FILES['cards.ndjson'].trim().split('\n');
    const boltErrata = bolt.replace('"oracleText":""', '"oracleText":"3 Schaden."');
    const newCard = forest.replace('"o2"', '"o3"').replace('Forest', 'Island').replace('"forest"', '"island"');
    const newName = '{"normName":"island","oracleId":"o3","lang":"en"}';
    const newer = { ...VERSION, catalogVersion: '20270101000000' };
    vi.stubGlobal('fetch', mockFetch({
      'cards.ndjson': () => streamResponse([boltErrata, forest, newCard].join('\n') + '\n'),
      'names.ndjson': () => streamResponse(FILES['names.ndjson'] + newName + '\n'),
    }));
    const cardsPut = vi.spyOn(db.cards, 'bulkPut');
    const printingsPut = vi.spyOn(db.printings, 'bulkPut');
    const namesPut = vi.spyOn(db.names, 'bulkPut');
    await importCatalog(newer, '/catalog');

    // Karten: geänderte (o1) + neue (o3); Forest unverändert → nicht geschrieben.
    expect(cardsPut.mock.calls.flatMap(([rows]) => rows.map((c) => c.oracleId))).toEqual(['o1', 'o3']);
    expect((await db.cards.get('o1'))?.oracleText).toBe('3 Schaden.');
    expect(printingsPut).not.toHaveBeenCalled();
    expect(namesPut.mock.calls.flatMap(([rows]) => rows.map((n) => n.normName))).toEqual(['island']);
    expect(await db.cards.count()).toBe(3);
    expect(await db.names.count()).toBe(4);
    expect(await getLocalCatalogVersion()).toBe(newer.catalogVersion);
  });

  it('liest gzip-komprimierte Dateien (*.ndjson.gz, Katalog von GitHub)', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const key = Object.keys(FILES).find((f) => url.endsWith(`${f}.gz`));
      if (!key) return new Response('not found', { status: 404 });
      const gz = gzipSync(Buffer.from(FILES[key], 'utf-8'));
      // in zwei Stücken liefern — die Zeilen dürfen auch über Chunk-Grenzen gehen
      const cut = Math.floor(gz.length / 2);
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(gz.subarray(0, cut)));
          c.enqueue(new Uint8Array(gz.subarray(cut)));
          c.close();
        },
      }), { status: 200 });
    }));
    await importCatalog(VERSION, 'https://example.org/catalog-latest', undefined, undefined, true);
    expect(urls.every((u) => u.endsWith('.ndjson.gz'))).toBe(true);
    expect(await db.cards.count()).toBe(2);
    expect(await db.names.count()).toBe(3);
    expect(await getLocalCatalogVersion()).toBe(VERSION.catalogVersion);
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

  it('eingebauter Katalog ÄLTER als der lokale (von GitHub geladen) -> up-to-date, kein Rückschritt', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const newer = { ...VERSION, catalogVersion: '20270101000000' };
    await importCatalog(newer, '/catalog'); // lokal = neuer Stand
    const r = await syncOnStartup({ base: '/catalog' }); // eingebaut = VERSION (älter)
    expect(r.status).toBe('up-to-date');
    expect(await getMeta('catalogVersion')).toBe(newer.catalogVersion);
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
