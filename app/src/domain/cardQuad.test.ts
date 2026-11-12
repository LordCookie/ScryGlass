import { describe, it, expect } from 'vitest';
import { findCardQuad, squareToQuad, mapPoint, warpQuad, type Quad, type Point } from './cardQuad';
import type { Rect } from './cardSnap';

/** Deterministisches Rauschen (LCG), damit die Tests stabil sind. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 3×3 aus [a..h] und invertiert — für das Zeichnen (Bildpunkt → Kartenkoordinate). */
function inverse(H: number[]): number[] {
  const [a, b, c, d, e, f, g, h] = H;
  const m = [a, b, c, d, e, f, g, h, 1];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  return [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
}

/** Karteninhalt an (u, v) ∈ [0,1]²: schwarzer Rand, Rahmen, Bild, Textkasten. */
function cardShade(u: number, v: number): number {
  if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) return 18;
  if (u > 0.08 && u < 0.92 && v > 0.11 && v < 0.55) return 70 + 40 * Math.sin(u * 40) * Math.cos(v * 30);
  if (u > 0.08 && u < 0.92 && v > 0.62 && v < 0.9) return 215;
  return 140;
}

const W = 256;
const H = 358;
const RETICLE: Rect = { l: 25, t: 35, r: 231, b: 323 };

/** Graustufen- und RGBA-Bild einer Karte als Viereck `q` auf Untergrund `bg`. */
function render(q: Quad, bg: number, seed = 3): { gray: Uint8Array; rgba: Uint8ClampedArray } {
  const inv = inverse(squareToQuad(q));
  const rand = rng(seed);
  const gray = new Uint8Array(W * H);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const z = inv[6] * px + inv[7] * py + inv[8];
      const u = (inv[0] * px + inv[1] * py + inv[2]) / z;
      const v = (inv[3] * px + inv[4] * py + inv[5]) / z;
      const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
      const val = Math.max(0, Math.min(255, Math.round((inside ? cardShade(u, v) : bg) + (rand() - 0.5) * 14)));
      gray[y * W + x] = val;
      rgba.set([val, val, val, 255], (y * W + x) * 4);
    }
  }
  return { gray, rgba };
}

/** Karte (Breite `cw`) um die Bildmitte, gedreht um `deg`. */
function rotated(deg: number, cw = 170): Quad {
  const ch = cw / (745 / 1040);
  const r = (deg * Math.PI) / 180;
  const cx = W / 2;
  const cy = H / 2;
  const pt = (dx: number, dy: number): Point => ({ x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) });
  return [pt(-cw / 2, -ch / 2), pt(cw / 2, -ch / 2), pt(cw / 2, ch / 2), pt(-cw / 2, ch / 2)];
}

function maxCornerError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

describe('Karte als Viereck finden', () => {
  it('gerade Karte: Ecken auf ~2 px, kaum Schräglage', () => {
    const q = rotated(0);
    const r = findCardQuad(render(q, 200).gray, W, H, RETICLE);
    expect(r).not.toBeNull();
    expect(maxCornerError(r!.quad, q)).toBeLessThan(2.5);
    expect(r!.tilt).toBeLessThan(1);
  });

  for (const deg of [6, -10, 15]) {
    it(`gedreht um ${deg}°`, () => {
      const q = rotated(deg);
      const r = findCardQuad(render(q, 190, 11).gray, W, H, RETICLE);
      expect(r).not.toBeNull();
      expect(maxCornerError(r!.quad, q)).toBeLessThan(3);
      expect(r!.tilt).toBeGreaterThan(Math.abs(deg) - 1.5);
      expect(r!.tilt).toBeLessThan(Math.abs(deg) + 1.5);
    });
  }

  it('gekippt (Perspektive: oben schmaler)', () => {
    const q: Quad = [{ x: 52, y: 62 }, { x: 204, y: 66 }, { x: 222, y: 300 }, { x: 34, y: 296 }];
    const r = findCardQuad(render(q, 205, 5).gray, W, H, RETICLE);
    expect(r).not.toBeNull();
    expect(maxCornerError(r!.quad, q)).toBeLessThan(3);
  });

  it('nimmt die Außenkante, nicht den Rand des Kartenrahmens', () => {
    // Heller Tisch: Außenkante (Tisch → schwarz) und Innenkante (schwarz → Rahmen) sind beide stark.
    const q = rotated(8, 180);
    const r = findCardQuad(render(q, 235, 9).gray, W, H, RETICLE);
    expect(r).not.toBeNull();
    expect(maxCornerError(r!.quad, q)).toBeLessThan(3);
  });

  it('ohne Karte: nichts', () => {
    const rand = rng(1);
    const g = new Uint8Array(W * H).map(() => 120 + Math.round((rand() - 0.5) * 30));
    expect(findCardQuad(g, W, H, RETICLE)).toBeNull();
  });
});

describe('Entzerren', () => {
  it('Homographie trifft die Ecken', () => {
    const q: Quad = [{ x: 10, y: 20 }, { x: 110, y: 25 }, { x: 120, y: 160 }, { x: 5, y: 150 }];
    const Hm = squareToQuad(q);
    const corners = [mapPoint(Hm, 0, 0), mapPoint(Hm, 1, 0), mapPoint(Hm, 1, 1), mapPoint(Hm, 0, 1)];
    corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(q[i].x, 6);
      expect(p.y).toBeCloseTo(q[i].y, 6);
    });
  });

  it('gedrehte Karte wird wieder gerade', () => {
    const q = rotated(12);
    const { rgba } = render(q, 190, 4);
    const outW = 73;
    const outH = 102;
    const out = warpQuad(rgba, W, H, q, outW, outH);
    let diff = 0;
    for (let j = 0; j < outH; j++) {
      for (let i = 0; i < outW; i++) {
        diff += Math.abs(out[(j * outW + i) * 4] - cardShade((i + 0.5) / outW, (j + 0.5) / outH));
      }
    }
    // Mittlere Abweichung klein (Rauschen ±7 und Kanten-Interpolation).
    expect(diff / (outW * outH)).toBeLessThan(9);
  });
});
