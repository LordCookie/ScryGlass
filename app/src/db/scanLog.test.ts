import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, logScan, markScanRejected } from './db';

describe('Scan-Protokoll (Rückgängig → Fehltreffer)', () => {
  beforeEach(async () => {
    await db.scans.clear();
  });

  it('logScan liefert die id; markScanRejected markiert den Eintrag, ohne Tuning-Werte zu verlieren', async () => {
    const id = await logScan({
      at: 1, ocrRaw: 'sol rlng', chosenOracle: 'o1', chosenName: 'Sol Ring', via: 'bild',
      hashDist: 40, hashMargin: 22, sharpness: 312, ocrConf: 71,
    });
    expect(typeof id).toBe('number');

    await markScanRejected(id!);
    const row = await db.scans.get(id!);
    expect(row).toMatchObject({ rejected: true, sharpness: 312, ocrConf: 71, hashDist: 40, chosenName: 'Sol Ring' });
  });

  it('nicht markierte Einträge bleiben Ground Truth', async () => {
    const id = await logScan({ at: 2, ocrRaw: '', chosenOracle: 'o2', chosenName: 'Forest', via: 'ocr' });
    expect((await db.scans.get(id!))?.rejected).toBeUndefined();
  });
});
