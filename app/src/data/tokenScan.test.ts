import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db, addOwned, addOwnedBatch } from '../db/db';
import type { Card, Printing } from '../domain/types';
import { normalizeName } from '../domain/nameMatch';
import { loadHashIndex, invalidateHashIndex, nearestByHashMulti, nearestPrintingsOf, hashCount, tokenHashCount, packBitsMsb } from './imageHash';
import { invalidateTokenCatalog, tokenOnlySets } from './tokenCatalog';
import { scanToken } from './tokenScan';
import { getTokenSummary, setTokenCount } from './tokens';
import { searchCards, searchTokens, invalidateSearchIndex } from './search';
import type { FuseConfig } from '../domain/scanFuse';

/** Großes Token-Update (M14): Bestand je Artwork, getrennter Bild-Index, Token-Scan. */

const CFG: FuseConfig = {
  hashMaxDist: 60, hashMinMargin: 12, hashAutoDist: 56, hashAutoMargin: 18,
  hashConfirmDist: 70, hashConfirmMargin: 4, ocrConfident: 0.85, ocrConfirm: 0.6,
};

const card = (oracleId: string, name: string, layout: string, typeLine: string): Card => ({
  oracleId, name, normName: normalizeName(name), manaCost: '', cmc: 0, colors: [], colorIdentity: [],
  typeLine, oracleText: '', layout, legalities: 0, maxCopies: 4,
});
const printing = (scryfallId: string, oracleId: string, set: string, collectorNumber: string): Printing => ({
  scryfallId, oracleId, set, collectorNumber, lang: 'en', finishes: ['nonfoil'],
});
/** 256-Bit-Hash mit den ersten `k` Bits gesetzt → Hamming-Distanz k zur Null-Query. */
const bits = (k: number) => packBitsMsb(Array.from({ length: 256 }, (_, i) => (i < k ? 1 : 0)));
const ZERO = bits(0);

beforeAll(async () => {
  await Promise.all([db.cards.clear(), db.printings.clear(), db.hashes.clear(), db.owned.clear(), db.names.clear()]);
  await db.cards.bulkPut([
    card('mouse-red', 'Mouse', 'token', 'Token Creature — Mouse'),
    card('mouse-white', 'Mouse', 'token', 'Token Creature — Mouse'),
    card('treasure-clue', 'Treasure // Clue', 'double_faced_token', 'Token Artifact — Treasure // Token Artifact — Clue'),
    card('bolt', 'Lightning Bolt', 'normal', 'Instant'),
    card('mouse-trapper', 'Mouse Trapper', 'normal', 'Creature — Mouse Soldier'),
  ]);
  await db.printings.bulkPut([
    printing('p-mr1', 'mouse-red', 'tblb', '4'),
    printing('p-mr2', 'mouse-red', 'tm3c', '12'),
    printing('p-mw1', 'mouse-white', 'tblb', '5'),
    printing('p-tc1', 'treasure-clue', 'sld', '900'),
    printing('p-bolt1', 'bolt', 'lea', '161'),
    printing('p-bolt2', 'bolt', 'sld', '901'),
  ]);
  await db.hashes.bulkPut([
    { scryfallId: 'p-bolt1', oracleId: 'bolt', h: bits(5) },
    { scryfallId: 'p-mr1', oracleId: 'mouse-red', h: bits(8) },
    { scryfallId: 'p-mr2', oracleId: 'mouse-red', h: bits(60) },
    { scryfallId: 'p-mw1', oracleId: 'mouse-white', h: bits(90) },
  ]);
  invalidateTokenCatalog();
  invalidateSearchIndex();
  invalidateHashIndex();
  await loadHashIndex();
});

describe('Bild-Index: Karten und Tokens getrennt', () => {
  it('zählt getrennt und sucht nur im eigenen Bereich', () => {
    expect(hashCount()).toBe(1);
    expect(tokenHashCount()).toBe(3);
    expect(nearestByHashMulti([ZERO])).toMatchObject({ oracleId: 'bolt', distance: 5 });
    // Token-Bereich: der Bolt (Distanz 5) zählt nicht; Margin gegen den anderen Token (gekappt).
    expect(nearestByHashMulti([ZERO], undefined, 'token')).toMatchObject({ scryfallId: 'p-mr1', distance: 8, margin: 48 });
  });

  it('nearestPrintingsOf: Artworks der gefragten Tokens, bildnächste zuerst', () => {
    const r = nearestPrintingsOf([ZERO, bits(58)], new Set(['mouse-red']), 5);
    expect(r).toEqual([
      { oracleId: 'mouse-red', scryfallId: 'p-mr2', distance: 2 },
      { oracleId: 'mouse-red', scryfallId: 'p-mr1', distance: 8 },
    ]);
  });
});

describe('scanToken', () => {
  it('Name + Bild bestätigen sich → genau dieses Artwork, sicher; Alternativen dahinter', async () => {
    const r = (await scanToken({ titleText: 'Mouse', hashes: [ZERO], collector: null, cfg: CFG }))!;
    expect(r.fused).toMatchObject({ method: 'bild+ocr', oracleId: 'mouse-red', confident: true });
    expect(r.arts.map((a) => a.scryfallId)).toEqual(['p-mr1', 'p-mr2', 'p-mw1']);
    expect(r.arts[0].card.name).toBe('Mouse');
  });

  it('Druckinfo „BLB 4" findet die Ausgabe im Token-Set (tblb)', async () => {
    const r = (await scanToken({ titleText: 'Mouse', collector: { set: 'blb', number: '4', lang: 'en' }, cfg: CFG }))!;
    expect(r.fused).toMatchObject({ method: 'druck', confident: true });
    expect(r.arts[0].scryfallId).toBe('p-mr1');
    expect(r.printRead).toBe('tblb 4 en');
  });

  it('Name allein: Artwork offen → nie sicher (kein Auto-Korb)', async () => {
    const r = (await scanToken({ titleText: 'Mouse', collector: null, cfg: CFG }))!;
    expect(r.fused.method).toBe('ocr');
    expect(r.fused.confident).toBe(false);
    expect(r.arts.map((a) => a.scryfallId).sort()).toEqual(['p-mr1', 'p-mr2', 'p-mw1']);
  });

  it('weder Name noch Bild → nichts gefunden; doppelseitig über den Namen einer Seite', async () => {
    const none = (await scanToken({ titleText: 'Goblin', hashes: [bits(200)], collector: null, cfg: CFG }))!;
    expect(none.arts).toEqual([]);
    const clue = (await scanToken({ titleText: 'Clue', collector: null, cfg: CFG }))!;
    expect(clue.arts.map((a) => a.oracleId)).toEqual(['treasure-clue']);
  });
});

describe('Bestand: Tokens je Artwork, Karten je Oracle', () => {
  it('zwei Artworks desselben Tokens = zwei Bestände; Rückgängig trifft das richtige', async () => {
    await db.owned.clear();
    await addOwned('mouse-red', 'nonfoil', 1, { printingId: 'p-mr1' });
    await addOwned('mouse-red', 'nonfoil', 1, { printingId: 'p-mr1' });
    await addOwned('mouse-red', 'nonfoil', 1, { printingId: 'p-mr2' });
    let rows = await db.owned.where('oracleId').equals('mouse-red').toArray();
    expect(rows.map((r) => [r.printingId, r.qty]).sort()).toEqual([['p-mr1', 2], ['p-mr2', 1]]);

    await addOwned('mouse-red', 'nonfoil', -1, { printingId: 'p-mr2' });
    rows = await db.owned.where('oracleId').equals('mouse-red').toArray();
    expect(rows.map((r) => [r.printingId, r.qty])).toEqual([['p-mr1', 2]]);
  });

  it('Karten bleiben ein Bestand je Ausführung, egal welches Artwork', async () => {
    await addOwned('bolt', 'nonfoil', 1, { printingId: 'p-bolt1' });
    await addOwned('bolt', 'nonfoil', 1, { printingId: 'p-bolt2' });
    const rows = await db.owned.where('oracleId').equals('bolt').toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(2);
  });

  it('Korb-Übernahme (Batch) trennt Token-Artworks ebenso; Überblick zählt sie', async () => {
    await addOwnedBatch([
      { oracleId: 'mouse-white', printingId: 'p-mw1', qty: 2 },
      { oracleId: 'mouse-red', printingId: 'p-mr2', qty: 1 },
    ]);
    const red = await db.owned.where('oracleId').equals('mouse-red').toArray();
    expect(red).toHaveLength(2);
    await setTokenCount(3);
    expect(await getTokenSummary()).toEqual({ withArt: 5, artworks: 3, withoutArt: 3 });
  });
});

describe('Suche und Sets ohne Tokens', () => {
  it('Kartensuche findet keine Tokens, die Token-Suche schon', async () => {
    expect((await searchCards('mouse')).map((c) => c.oracleId)).toEqual(['mouse-trapper']);
    expect((await searchTokens('mouse')).map((c) => c.oracleId).sort()).toEqual(['mouse-red', 'mouse-white']);
  });

  it('reine Token-Sets erkennen (Set mit Karten und Tokens zählt nicht dazu)', async () => {
    expect([...(await tokenOnlySets())].sort()).toEqual(['tblb', 'tm3c']);
  });
});
