import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/db';
import {
  loadHashIndex, invalidateHashIndex, nearestByHash, nearestByHashMulti, hashIndicesFor, packBitsMsb, distanceToOracle,
} from './imageHash';

/** 256-Bit-Hash mit den ersten `k` Bits gesetzt → Hamming-Distanz k zur Null-Query. */
const hashWithBits = (k: number) => packBitsMsb(Array.from({ length: 256 }, (_, i) => (i < k ? 1 : 0)));
const ZERO = hashWithBits(0);

describe('Bild-Index mit Set-Filter', () => {
  beforeAll(async () => {
    await db.hashes.clear();
    await db.hashes.bulkPut([
      { scryfallId: 'a1', oracleId: 'A', h: hashWithBits(10) }, // Set X
      { scryfallId: 'b1', oracleId: 'B', h: hashWithBits(5) }, // Set Y — global am nächsten
      { scryfallId: 'c1', oracleId: 'C', h: hashWithBits(30) }, // Set X
    ]);
    invalidateHashIndex();
    await loadHashIndex();
  });

  it('ohne Filter gewinnt der global nächste Hash; Margin gegen die nächste fremde Karte', () => {
    expect(nearestByHash(ZERO)).toMatchObject({ oracleId: 'B', scryfallId: 'b1', distance: 5, margin: 5 });
  });

  it('mit Set-Filter zählen nur Karten aus dem Set — auch für den Margin', () => {
    const subset = hashIndicesFor(new Set(['a1', 'c1']));
    expect(Array.from(subset)).toHaveLength(2);
    expect(nearestByHash(ZERO, subset)).toMatchObject({ oracleId: 'A', distance: 10, margin: 20 });
    // Mehrere Varianten: die Variante, die A am nächsten ist (12 Bit → Distanz 2), gewinnt.
    expect(nearestByHashMulti([ZERO, hashWithBits(12)], subset)).toMatchObject({ oracleId: 'A', distance: 2 });
  });

  it('distanceToOracle: Abstand zur bestätigten Karte, beste Variante zählt', () => {
    expect(distanceToOracle([ZERO], 'C')).toEqual({ distance: 30, scryfallId: 'c1' });
    expect(distanceToOracle([ZERO, hashWithBits(28)], 'C')).toMatchObject({ distance: 2 });
    expect(distanceToOracle([ZERO], 'unbekannt')).toBeNull();
    expect(distanceToOracle([], 'A')).toBeNull();
  });
});
