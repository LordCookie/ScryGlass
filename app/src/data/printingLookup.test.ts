import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/db';
import { findPrinting, setMembers, catalogSetCodes } from './printingLookup';

describe('Ausgaben-Suche per Set + Sammlernummer', () => {
  beforeAll(async () => {
    await db.printings.clear();
    await db.printings.bulkPut([
      { scryfallId: 'dmu-123-en', oracleId: 'A', set: 'dmu', collectorNumber: '123', lang: 'en', finishes: ['nonfoil'] },
      { scryfallId: 'dmu-123-de', oracleId: 'A', set: 'dmu', collectorNumber: '123', lang: 'de', finishes: ['nonfoil'] },
      { scryfallId: 'dmu-45a-en', oracleId: 'B', set: 'dmu', collectorNumber: '45a', lang: 'en', finishes: ['nonfoil'] },
      { scryfallId: 'mom-7-en', oracleId: 'C', set: 'mom', collectorNumber: '7', lang: 'en', finishes: ['foil'] },
    ]);
  });

  it('findet die Ausgabe und bevorzugt die gelesene Sprache', async () => {
    expect((await findPrinting('DMU', '123', 'de'))?.scryfallId).toBe('dmu-123-de');
    expect((await findPrinting('dmu', '123', 'fr'))?.scryfallId).toBe('dmu-123-en'); // Fallback EN
  });

  it('verträgt führende Nullen und Buchstaben-Suffix', async () => {
    expect((await findPrinting('mom', '0007'))?.oracleId).toBe('C');
    expect((await findPrinting('dmu', '45A'))?.oracleId).toBe('B');
  });

  it('liefert nichts bei unbekannter Nummer', async () => {
    expect(await findPrinting('dmu', '999')).toBeUndefined();
  });

  it('Set-Mitglieder und Set-Codes', async () => {
    const m = await setMembers('DMU');
    expect([...m.oracleIds].sort()).toEqual(['A', 'B']);
    expect(m.scryfallIds.size).toBe(3);
    expect(await catalogSetCodes()).toEqual(['dmu', 'mom']);
  });
});
