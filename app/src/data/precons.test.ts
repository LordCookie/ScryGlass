import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, addOwned } from '../db/db';
import {
  syncPrecons, listPrecons, addPreconToCollection, removePreconFromCollection, previewPreconRemoval, listOwnedPrecons,
} from './precons';

vi.mock('./backups', () => ({ autoBackup: vi.fn(async () => null) }));

const FILE = [
  JSON.stringify({ meta: { source: 'MTGJSON', count: 2 }, printings: ['p-cmd', 'p-sol', 'p-plains', 'p-tok', 'p-sol-alt'] }),
  JSON.stringify(['Cav_MOC', 'Cavalry Charge', 'moc', '2023-04-21', 'commander', 'Commander Deck', [[0, 1, 1]], [[1, 1, 0], [2, 30, 0]], [], [], [[3, 2, 0]], 0]),
  JSON.stringify(['Old_TST', 'Old Theme', 'tst', '2001-01-01', 'starter', 'Theme Deck', [], [[4, 4, 0]], [], [], [], 0]),
].join('\n');

beforeEach(async () => {
  await Promise.all([db.meta.clear(), db.cards.clear(), db.names.clear(), db.printings.clear(), db.owned.clear(),
    db.decks.clear(), db.precons.clear(), db.ownedPrecons.clear()]);
  await db.cards.bulkPut([
    { oracleId: 'o-cmd', name: 'Sidar Jabari of Zhalfir', normName: 'sidar jabari of zhalfir', layout: 'normal' },
    { oracleId: 'o-sol', name: 'Sol Ring', normName: 'sol ring', layout: 'normal' },
    { oracleId: 'o-plains', name: 'Plains', normName: 'plains', layout: 'normal' },
    { oracleId: 'o-soldier', name: 'Soldier', normName: 'soldier', layout: 'token' },
  ] as never[]);
  await db.printings.bulkPut([
    { scryfallId: 'p-cmd', oracleId: 'o-cmd' }, { scryfallId: 'p-sol', oracleId: 'o-sol' },
    { scryfallId: 'p-plains', oracleId: 'o-plains' }, { scryfallId: 'p-tok', oracleId: 'o-soldier' },
    { scryfallId: 'p-sol-alt', oracleId: 'o-sol' },
  ] as never[]);
  await db.names.bulkPut([{ normName: 'sidar jabari von zhalfir', oracleId: 'o-cmd', lang: 'de' }]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/catalog/precons.ndjson' ? new Response(FILE, { status: 200 }) : new Response('nope', { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('Fertigdecks einspielen', () => {
  it('liest die Datei, neueste zuerst, Commander-Namen im Suchtext', async () => {
    expect(await syncPrecons('/catalog', 'v1')).toBe('imported');
    const list = await listPrecons();
    expect(list.map((p) => p.key)).toEqual(['Cav_MOC', 'Old_TST']);
    expect(list[0].search).toContain('zhalfir');
    expect(list[0].search).toContain('von');
    expect(await syncPrecons('/catalog', 'v1')).toBe('skipped');
    expect(await syncPrecons('/ohne', 'v2')).toBe('absent');
    expect(await listPrecons()).toHaveLength(2); // alte Daten bleiben
  });
});

describe('In die Sammlung und wieder heraus', () => {
  it('bucht Karten (Artwork bleibt), legt das Deck an und merkt sich alles', async () => {
    await syncPrecons('/catalog', 'v1');
    await addOwned('o-sol', 'nonfoil', 1, { printingId: 'p-sol-alt' }); // eigenes Artwork gewählt
    const [cav] = await listPrecons();
    const res = await addPreconToCollection(cav, { copies: 1, withTokens: true, createDeck: true });
    expect(res).toMatchObject({ cards: 32, tokens: 2, unknown: 0 });
    const sol = await db.owned.where('oracleId').equals('o-sol').first();
    expect(sol).toMatchObject({ qty: 2, printingId: 'p-sol-alt', source: 'manual' }); // Herkunft bleibt auch
    expect(await db.owned.where('oracleId').equals('o-cmd').first()).toMatchObject({ finish: 'foil', printingId: 'p-cmd', source: 'precon' });
    const deck = await db.decks.get(res.deckId!);
    expect(deck).toMatchObject({ name: 'Cavalry Charge', format: 'commander', commanderId: 'o-cmd' });
    const [op] = await listOwnedPrecons();
    expect(op).toMatchObject({ key: 'Cav_MOC', deckId: res.deckId, copies: 1 });

    // Eine Plains schon weg (verkauft): Vorschau sagt es, Entfernen zieht den Rest ab.
    await addOwned('o-plains', 'nonfoil', -1);
    expect(await previewPreconRemoval(op)).toEqual({ total: 34, missing: 1 });
    expect(await removePreconFromCollection(op, { deleteDeck: true })).toBe(33);
    expect(await db.owned.where('oracleId').equals('o-sol').first()).toMatchObject({ qty: 1 }); // eigene bleibt
    expect(await db.owned.where('oracleId').equals('o-plains').count()).toBe(0);
    expect(await db.owned.where('oracleId').equals('o-soldier').count()).toBe(0);
    expect(await db.decks.count()).toBe(0);
    expect(await listOwnedPrecons()).toEqual([]);
  });

  it('zweimal kaufen, ohne Tokens, ohne Deck', async () => {
    await syncPrecons('/catalog', 'v1');
    const [cav] = await listPrecons();
    const res = await addPreconToCollection(cav, { copies: 2, withTokens: false, createDeck: false });
    expect(res).toMatchObject({ cards: 64, tokens: 0 });
    expect(res.deckId).toBeUndefined();
    expect(await db.owned.where('oracleId').equals('o-plains').first()).toMatchObject({ qty: 60 });
    expect(await db.owned.where('oracleId').equals('o-soldier').count()).toBe(0);
  });
});
