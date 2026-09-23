import { describe, it, expect } from 'vitest';
import { laplacianVariance, normalizedPoint } from './focus';

describe('laplacianVariance', () => {
  it('ist 0 bei einer gleichmäßigen Fläche (maximal unscharf)', () => {
    const w = 8, h = 8;
    const flat = new Uint8Array(w * h).fill(128);
    expect(laplacianVariance(flat, w, h)).toBe(0);
  });

  it('ist hoch bei einem harten Schachbrett (maximal scharf)', () => {
    const w = 8, h = 8;
    const checker = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) checker[y * w + x] = (x + y) % 2 ? 255 : 0;
    expect(laplacianVariance(checker, w, h)).toBeGreaterThan(1000);
  });

  it('scharfe Kante hat mehr Varianz als ein weicher Verlauf', () => {
    const w = 16, h = 16;
    const edge = new Uint8Array(w * h);
    const ramp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        edge[y * w + x] = x < w / 2 ? 0 : 255; // harte Kante
        ramp[y * w + x] = Math.round((x / (w - 1)) * 255); // weicher Verlauf
      }
    }
    expect(laplacianVariance(edge, w, h)).toBeGreaterThan(laplacianVariance(ramp, w, h));
  });

  it('gibt 0 zurück bei zu kleinem Bild', () => {
    expect(laplacianVariance(new Uint8Array(4).fill(200), 2, 2)).toBe(0);
  });
});

describe('normalizedPoint', () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };

  it('rechnet die Klickmitte auf (0.5, 0.5) um', () => {
    expect(normalizedPoint(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clampt Klicks außerhalb auf 0..1', () => {
    expect(normalizedPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizedPoint(9999, 9999, rect)).toEqual({ x: 1, y: 1 });
  });

  it('fällt bei Breite/Höhe 0 auf die Mitte zurück', () => {
    expect(normalizedPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });
});
