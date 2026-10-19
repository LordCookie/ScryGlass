import { describe, it, expect } from 'vitest';
import { snapCard, hashVariantRects, CARD_ASPECT, type Rect } from './cardSnap';

/** Deterministisches Rauschen (LCG), damit die Tests stabil sind. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Scene {
  w: number;
  h: number;
  bg: number;
  card: Rect;
  border?: number;
  /** zweite Karte dahinter (Stapel) */
  under?: Rect;
}

/**
 * Künstliches Kamerabild: Untergrund mit Rauschen, Karte mit dunklem Rand, hellerem
 * Rahmen, Bild- und Textkasten (innere Kanten, die NICHT gewählt werden dürfen).
 */
function render(sc: Scene): Uint8Array {
  const { w, h, bg } = sc;
  const g = new Uint8Array(w * h);
  const rand = rng(7);
  const inside = (r: Rect, x: number, y: number) => x >= r.l && x < r.r && y >= r.t && y < r.b;
  const paint = (c: Rect, x: number, y: number): number | null => {
    if (!inside(c, x, y)) return null;
    const cw = c.r - c.l;
    const ch = c.b - c.t;
    const bx = (sc.border ?? 0.04) * cw;
    const inner: Rect = { l: c.l + bx, t: c.t + bx, r: c.r - bx, b: c.b - bx };
    if (!inside(inner, x, y)) return 18; // schwarzer Kartenrand
    const art: Rect = { l: c.l + 0.08 * cw, t: c.t + 0.11 * ch, r: c.r - 0.08 * cw, b: c.t + 0.55 * ch };
    const text: Rect = { l: c.l + 0.08 * cw, t: c.t + 0.62 * ch, r: c.r - 0.08 * cw, b: c.t + 0.9 * ch };
    if (inside(art, x, y)) return 70 + 40 * Math.sin(x / 5) * Math.cos(y / 7); // Illustration
    if (inside(text, x, y)) return 215; // Textkasten
    return 140; // Rahmenfarbe
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = paint(sc.card, x, y);
      if (v == null && sc.under) v = paint(sc.under, x, y);
      if (v == null) v = bg;
      g[y * w + x] = Math.max(0, Math.min(255, Math.round(v + (rand() - 0.5) * 16)));
    }
  }
  return g;
}

/** Kartenrechteck im Kartenformat um einen Mittelpunkt. */
function cardAt(cx: number, cy: number, width: number): Rect {
  const height = width / (745 / 1040);
  return { l: Math.round(cx - width / 2), t: Math.round(cy - height / 2), r: Math.round(cx + width / 2), b: Math.round(cy + height / 2) };
}

const W = 256;
const H = 350;
/** Scan-Rahmen mit ~12 % Luft im Ausschnitt (wie von der nativen Kamera geliefert). */
const RETICLE: Rect = { l: 25, t: 33, r: 231, b: 317 };

function expectNear(a: Rect, b: Rect, tol: number) {
  expect(Math.abs(a.l - b.l)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.t - b.t)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.r - b.r)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.b - b.b)).toBeLessThanOrEqual(tol);
}

describe('snapCard', () => {
  it('Karte kleiner als der Rahmen (weiter weg gehalten) → rastet auf die Karte ein', () => {
    const card = cardAt(128, 175, 160);
    const res = snapCard(render({ w: W, h: H, bg: 200, card }), W, H, RETICLE);
    expect(res.snapped).toBe(true);
    expectNear(res.rect, card, 3);
  });

  it('Karte versetzt im Rahmen → findet die echte Lage', () => {
    const card = cardAt(150, 160, 185);
    const res = snapCard(render({ w: W, h: H, bg: 190, card }), W, H, RETICLE);
    expect(res.snapped).toBe(true);
    expectNear(res.rect, card, 3);
  });

  it('dunkler Untergrund (Rand kaum sichtbar) → höchstens knapp innerhalb der Karte', () => {
    const card = cardAt(128, 175, 180);
    const res = snapCard(render({ w: W, h: H, bg: 24, card }), W, H, RETICLE);
    expect(res.snapped).toBe(true);
    // Statt der Außenkante greift die Kante Rand → Rahmenfarbe (≈ 4 % innen).
    expectNear(res.rect, card, 10);
  });

  it('keine Karte im Bild → bleibt beim Rahmen', () => {
    const empty = render({ w: W, h: H, bg: 120, card: { l: -10, t: -10, r: -5, b: -5 } });
    const res = snapCard(empty, W, H, RETICLE);
    expect(res.snapped).toBe(false);
    expect(res.rect).toEqual(RETICLE);
  });

  it('wählt keine inneren Linien (Bild-/Textkasten) als Kartenkante', () => {
    const card = cardAt(128, 175, 200);
    const res = snapCard(render({ w: W, h: H, bg: 205, card }), W, H, RETICLE);
    expect(res.snapped).toBe(true);
    // Oben/unten genau die Kartenkanten, nicht Bildkasten (11 %) oder Textkasten (90 %).
    expect(Math.abs(res.rect.t - card.t)).toBeLessThanOrEqual(3);
    expect(Math.abs(res.rect.b - card.b)).toBeLessThanOrEqual(3);
  });

  it('zu kleiner Rahmen/Ausschnitt → kein Einrasten', () => {
    const g = new Uint8Array(10 * 10);
    expect(snapCard(g, 10, 10, { l: 1, t: 1, r: 9, b: 9 }).snapped).toBe(false);
  });
});

describe('hashVariantRects', () => {
  const r: Rect = { l: 10, t: 20, r: 110, b: 160 };
  const aspect = (x: Rect) => (x.r - x.l) / (x.b - x.t);

  it('Rahmen: 6 Ausschnitte im Kartenformat; eingerastet: 7, Format höchstens ~5 % daneben', () => {
    const plain = hashVariantRects(r, false);
    expect(plain).toHaveLength(6);
    for (const x of plain) expect(aspect(x)).toBeCloseTo(aspect(r), 6);
    const snapped = hashVariantRects(r, true);
    expect(snapped).toHaveLength(7);
    expect(snapped[0]).toEqual(r);
    for (const x of snapped) expect(Math.abs(aspect(x) / aspect(r) - 1)).toBeLessThan(0.05);
  });

  it('eingerastet: Ecken-Varianten innerhalb, Rand-Varianten außerhalb; Rahmen: verschobene gleich groß', () => {
    const snapped = hashVariantRects(r, true);
    for (const x of snapped.slice(5)) {
      expect(x.l).toBeLessThan(r.l);
      expect(x.b).toBeGreaterThan(r.b);
    }
    for (const x of snapped.slice(1, 5)) {
      expect(x.l).toBeGreaterThanOrEqual(r.l);
      expect(x.r).toBeLessThanOrEqual(r.r);
      expect(x.t).toBeGreaterThanOrEqual(r.t);
      expect(x.b).toBeLessThanOrEqual(r.b);
    }
    for (const x of hashVariantRects(r, false).slice(2)) {
      expect(x.r - x.l).toBeCloseTo(100, 6);
      expect(x.b - x.t).toBeCloseTo(140, 6);
    }
    expect(CARD_ASPECT).toBeCloseTo(0.7163, 3);
  });
});
