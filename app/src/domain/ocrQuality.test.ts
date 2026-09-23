import { describe, it, expect } from 'vitest';
import { pickBestRead, ocrEffectiveScore, OCR_CONF_MIN, OCR_LOW_CONF_CAP } from './ocrQuality';

describe('pickBestRead', () => {
  it('nimmt die Lesung mit der höchsten Sicherheit', () => {
    const r = pickBestRead([
      { text: 'Lightnlng Bolt', confidence: 61 },
      { text: 'Lightning Bolt', confidence: 88 },
    ]);
    expect(r.text).toBe('Lightning Bolt');
  });

  it('ignoriert leere Lesungen, auch wenn sie „sicher" sind', () => {
    const r = pickBestRead([
      { text: '   ', confidence: 95 },
      { text: 'Sol Ring', confidence: 40 },
    ]);
    expect(r.text).toBe('Sol Ring');
  });

  it('liefert eine leere Lesung, wenn nichts gelesen wurde', () => {
    expect(pickBestRead([{ text: '', confidence: 90 }])).toEqual({ text: '', confidence: 0 });
    expect(pickBestRead([])).toEqual({ text: '', confidence: 0 });
  });
});

describe('ocrEffectiveScore', () => {
  it('lässt sichere Lesungen unverändert', () => {
    expect(ocrEffectiveScore(0.95, OCR_CONF_MIN)).toBe(0.95);
  });

  it('deckelt unsichere Lesungen unter die Auto-Schwelle', () => {
    expect(ocrEffectiveScore(0.95, OCR_CONF_MIN - 1)).toBe(OCR_LOW_CONF_CAP);
    expect(OCR_LOW_CONF_CAP).toBeLessThan(0.85); // kann OCR-allein-Auto nicht mehr auslösen
    expect(OCR_LOW_CONF_CAP).toBeGreaterThanOrEqual(0.6); // kann weiter bestätigen
  });

  it('hebt niedrige Scores nie an', () => {
    expect(ocrEffectiveScore(0.4, 10)).toBe(0.4);
  });
});
