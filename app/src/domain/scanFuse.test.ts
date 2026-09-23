import { describe, it, expect } from 'vitest';
import { fuseScan, type FuseConfig, type OcrSignal, type HashSignal } from './scanFuse';

const CFG: FuseConfig = {
  hashMaxDist: 60,
  hashMinMargin: 12,
  hashAutoDist: 56,
  hashAutoMargin: 18,
  hashConfirmDist: 70,
  hashConfirmMargin: 4,
  ocrConfident: 0.85,
  ocrConfirm: 0.6,
};

const noOcr: OcrSignal = { oracleId: undefined, score: 0, ambiguous: false };

describe('fuseScan', () => {
  it('Kreuz-Bestätigung: gleiche Karte aus OCR+Bild → sicher, auch wenn Bild allein schwach', () => {
    const ocr: OcrSignal = { oracleId: 'A', score: 0.65, ambiguous: false };
    const hash: HashSignal = { oracleId: 'A', distance: 66, margin: 6 }; // > MaxDist, aber im Confirm-Gate
    const r = fuseScan(ocr, hash, CFG);
    expect(r.method).toBe('bild+ocr');
    expect(r.oracleId).toBe('A');
    expect(r.agree).toBe(true);
    expect(r.confident).toBe(true);
    expect(r.showAlone).toBe(false);
  });

  it('starker Bildtreffer allein → sicher, nur Bild zeigen', () => {
    const hash: HashSignal = { oracleId: 'A', distance: 40, margin: 30 };
    const r = fuseScan(noOcr, hash, CFG);
    expect(r.method).toBe('bild');
    expect(r.confident).toBe(true);
    expect(r.showAlone).toBe(true);
  });

  it('Bild als Kandidat, aber nicht stark → anzeigen, nicht auto', () => {
    const hash: HashSignal = { oracleId: 'A', distance: 58, margin: 14 }; // im Show-Gate, unter Auto
    const r = fuseScan(noOcr, hash, CFG);
    expect(r.method).toBe('bild');
    expect(r.confident).toBe(false);
    expect(r.showAlone).toBe(false);
  });

  it('OCR allein sehr sicher → auto', () => {
    const ocr: OcrSignal = { oracleId: 'B', score: 0.92, ambiguous: false };
    const r = fuseScan(ocr, null, CFG);
    expect(r.method).toBe('ocr');
    expect(r.confident).toBe(true);
  });

  it('OCR sicher aber mehrdeutig → nicht auto', () => {
    const ocr: OcrSignal = { oracleId: 'B', score: 0.92, ambiguous: true };
    const r = fuseScan(ocr, null, CFG);
    expect(r.confident).toBe(false);
  });

  it('Bild schlägt OCR bei Uneinigkeit (Priorität wie bisher)', () => {
    const ocr: OcrSignal = { oracleId: 'B', score: 0.9, ambiguous: false };
    const hash: HashSignal = { oracleId: 'A', distance: 50, margin: 20 }; // stark
    const r = fuseScan(ocr, hash, CFG);
    expect(r.oracleId).toBe('A');
    expect(r.method).toBe('bild');
    expect(r.confident).toBe(true);
  });

  it('keine Bestätigung, wenn Bild zu weit weg ist (über Confirm-Gate)', () => {
    const ocr: OcrSignal = { oracleId: 'A', score: 0.7, ambiguous: false };
    const hash: HashSignal = { oracleId: 'A', distance: 90, margin: 5 }; // > ConfirmDist
    const r = fuseScan(ocr, hash, CFG);
    expect(r.agree).toBe(false);
    // Bild nicht im Show-Gate → fällt auf OCR (0.7 < 0.85 → nicht sicher).
    expect(r.method).toBe('ocr');
    expect(r.confident).toBe(false);
  });

  it('Druckinfo + passender Name → sicher, auch wenn der Name allein zu schwach wäre', () => {
    const ocr: OcrSignal = { oracleId: 'A', score: 0.65, ambiguous: false };
    const r = fuseScan(ocr, null, CFG, { oracleId: 'A' });
    expect(r).toMatchObject({ method: 'druck', oracleId: 'A', confident: true });
  });

  it('Druckinfo + passendes Bild → sicher', () => {
    const r = fuseScan(noOcr, { oracleId: 'A', distance: 68, margin: 2 }, CFG, { oracleId: 'A' });
    expect(r).toMatchObject({ method: 'druck', confident: true });
  });

  it('Druckinfo allein ist nicht auto-sicher (Ziffern können falsch gelesen sein)', () => {
    const r = fuseScan(noOcr, null, CFG, { oracleId: 'A' });
    expect(r).toMatchObject({ method: 'druck', oracleId: 'A', confident: false });
  });

  it('widersprüchliche Druckinfo verdrängt keinen starken Bildtreffer', () => {
    const r = fuseScan(noOcr, { oracleId: 'B', distance: 40, margin: 30 }, CFG, { oracleId: 'A' });
    expect(r).toMatchObject({ method: 'bild', oracleId: 'B', confident: true });
  });

  it('nichts Brauchbares → none', () => {
    const r = fuseScan(noOcr, null, CFG);
    expect(r.method).toBe('none');
    expect(r.oracleId).toBeUndefined();
  });
});
