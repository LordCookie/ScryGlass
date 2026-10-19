import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/db';
import {
  loadHashIndex, invalidateHashIndex, nearestByHash, nearestByHashMulti, hashIndicesFor, packBitsMsb, distanceToOracle,
  popcount32, hammingHex, betterMatch, MARGIN_CAP, type HashMatch,
} from './imageHash';

describe('betterMatch', () => {
  const m = (oracleId: string, distance: number, margin: number): HashMatch => ({ oracleId, scryfallId: oracleId, distance, margin, score: 0 });
  it('größerer Vorsprung gewinnt, sonst kleinere Distanz; null zählt nicht', () => {
    expect(betterMatch(m('a', 30, 20), m('b', 20, 8))?.oracleId).toBe('a');
    expect(betterMatch(m('a', 30, 10), m('b', 20, 10))?.oracleId).toBe('b');
    expect(betterMatch(null, m('b', 20, 8))?.oracleId).toBe('b');
    expect(betterMatch(m('a', 50, 2), null)?.oracleId).toBe('a');
    expect(betterMatch(null, null)).toBeNull();
  });
});

describe('schnelle Hash-Suche (32-Bit-Wörter) = byteweiser Vergleich', () => {
  let seed = 12345;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const randomHash = () => packBitsMsb(Array.from({ length: 256 }, () => (rand() < 0.5 ? 1 : 0)));

  it('popcount32 zählt korrekt, auch mit gesetztem Vorzeichenbit', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff | 0)).toBe(32);
    expect(popcount32(0x80000001 | 0)).toBe(2);
    expect(popcount32(0x0f0f0f0f)).toBe(16);
  });

  /** Kopie eines Hashes mit `k` zufällig gekippten Bits (= „ähnliches Bild"). */
  const flip = (hex: string, k: number) => {
    const bits = Array.from(hex, (ch) => parseInt(ch, 16).toString(2).padStart(4, '0')).join('').split('').map(Number);
    for (let i = 0; i < k; i++) {
      const j = Math.floor(rand() * 256);
      bits[j] ^= 1;
    }
    return packBitsMsb(bits);
  };

  const setup = async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ scryfallId: `s${i}`, oracleId: `o${i % 120}`, h: randomHash() }));
    await db.hashes.clear();
    await db.hashes.bulkPut(rows);
    invalidateHashIndex();
    await loadHashIndex();
    return rows;
  };
  /** Kleinste Distanz über alle Varianten × Einträge (Brute Force). */
  const bruteBest = (qs: string[], rows: { h: string }[]) => Math.min(...qs.flatMap((q) => rows.map((r) => hammingHex(q, r.h))));
  /** Margin wie definiert: nächste FREMDE Karte zur Gewinner-Variante. */
  const bruteMargin = (qs: string[], rows: { oracleId: string; h: string }[], oracleId: string, dist: number) => {
    const winQ = qs.find((q) => rows.some((r) => r.oracleId === oracleId && hammingHex(q, r.h) === dist))!;
    return Math.min(...rows.filter((r) => r.oracleId !== oracleId).map((r) => hammingHex(winQ, r.h))) - dist;
  };

  it('nahe Treffer (wie echte Karten): Distanz und Margin exakt wie per Brute Force', async () => {
    const rows = await setup();
    for (let t = 0; t < 30; t++) {
      // ähnliches Bild einer Karte (8–37 gekippte Bits) + eine zufällige Variante
      const qs = [flip(rows[(t * 7) % rows.length].h, 8 + t), randomHash()];
      const m = nearestByHashMulti(qs)!;
      expect(m.distance).toBe(bruteBest(qs, rows));
      expect(m.margin).toBe(Math.min(MARGIN_CAP, bruteMargin(qs, rows, m.oracleId, m.distance)));
    }
  });

  it('ferne Anfragen: nie besser als das echte Minimum, Distanz stimmt für die gemeldete Karte', async () => {
    const rows = await setup();
    for (let t = 0; t < 20; t++) {
      const qs = [randomHash(), randomHash()];
      const m = nearestByHashMulti(qs)!;
      expect(m.distance).toBeGreaterThanOrEqual(bruteBest(qs, rows));
      // exakt für das Paar (Eintrag, Variante), das die Vorauswahl passiert hat
      const entry = rows.find((r) => r.scryfallId === m.scryfallId)!;
      expect(qs.some((q) => hammingHex(q, entry.h) === m.distance)).toBe(true);
    }
  });
});

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
