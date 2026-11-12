/**
 * Schräg gehaltene Karten entzerren (PLAN.md M20, Teil 5). `cardSnap.ts` sucht ein
 * achsparalleles Rechteck — ist die Karte gedreht oder gekippt, findet es nichts, und der
 * Bild-Hash sieht den Rahmen samt Tisch. Hier wird jede der vier Kanten als (leicht
 * schräge) Gerade gesucht, die Ecken als Schnittpunkte berechnet und die Karte per
 * Homographie gerade gerechnet. Framework-frei, ohne Bibliothek, rein testbar.
 *
 * Vorgehen je Seite: viele Suchlinien quer zur Kante (mittlere 60 %), je Linie die
 * stärksten Helligkeitssprünge → robuste Gerade durch möglichst viele Linien (alle
 * Punktpaare probieren, Treffer zählen) → gibt es knapp außerhalb eine fast gleich gute,
 * parallele Gerade, ist das die Außenkante (innen liegt der Rand des Kartenrahmens) →
 * Feinschliff mit kleinsten Quadraten. Ecken prüfen: konvex, Kartenformat, mäßige
 * Perspektive. Findet sich nichts Überzeugendes: `null` (dann bleibt das Rechteck).
 */
import { CARD_ASPECT, type Rect } from './cardSnap';

export interface Point {
  x: number;
  y: number;
}

/** Ecken im Uhrzeigersinn: oben links, oben rechts, unten rechts, unten links. */
export type Quad = [Point, Point, Point, Point];

export interface QuadResult {
  quad: Quad;
  /** größte Abweichung einer Kante von der Achse, in Grad */
  tilt: number;
  /** mittlere Kantenstärke relativ zum Grundrauschen (Diagnose) */
  score: number;
}

/** Suchlinien je Seite */
const LINES = 21;
/** nur die mittleren 60 % einer Seite absuchen (Ecken, Nachbarkarten) */
const BAND = 0.2;
/** so weit darf die Kante innerhalb des Rahmens liegen (Anteil der Rahmengröße) */
const INWARD = 0.35;
/** Kandidaten je Suchlinie */
const PEAKS = 3;
/** größte Schräglage einer Kante */
const MAX_TILT_DEG = 25;
/** Abstand eines Punkts zur Geraden, der noch zählt (px) */
const INLIER_PX = 1.6;
/** Anteil der Suchlinien, die die Gerade treffen müssen */
const MIN_COVER = 0.45;
/** jede Kante muss sich so deutlich vom Grundrauschen abheben */
const MIN_EDGE_RATIO = 2.2;
/** Außenkante statt Innenkante, wenn sie mindestens so stark ist … */
const OUTER_MIN_SHARE = 0.5;
/** … und höchstens so weit außen liegt (Anteil der Kartenbreite, Kartenrand ≈ 4 %) */
const OUTER_MAX_GAP = 0.09;
/** erlaubte Abweichung vom Kartenformat (Perspektive staucht) */
const MAX_ASPECT_ERR = 0.22;
/** Verhältnis gegenüberliegender Seiten (Perspektive) */
const MAX_SIDE_RATIO = 1.35;

type Side = 'left' | 'right' | 'top' | 'bottom';

interface EdgePoint {
  /** Position quer zur Kante (x bei links/rechts, y bei oben/unten) */
  across: number;
  /** Position entlang der Kante */
  along: number;
  strength: number;
  line: number;
}

/** Gerade als across = m·along + c (fast achsparallel, daher eindeutig). */
interface Line {
  m: number;
  c: number;
  score: number;
  cover: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const a = [...values].sort((x, y) => x - y);
  return a[a.length >> 1];
}

/**
 * Kantenpunkte einer Seite. Senkrechte Seiten: waagerechte Suchlinien (Sprung in x,
 * gemittelt über 3 Zeilen); waagerechte Seiten umgekehrt.
 */
function edgePoints(g: ArrayLike<number>, w: number, h: number, ret: Rect, side: Side): { pts: EdgePoint[]; noise: number } {
  const vertical = side === 'left' || side === 'right';
  const rw = ret.r - ret.l;
  const rh = ret.b - ret.t;
  const alongLen = vertical ? h : w;
  const acrossLen = vertical ? w : h;
  const a0 = vertical ? ret.t + BAND * rh : ret.l + BAND * rw;
  const a1 = vertical ? ret.b - BAND * rh : ret.r - BAND * rw;
  // Suchfenster quer zur Kante: vom Bildrand bis ein Stück in den Rahmen hinein.
  const size = vertical ? rw : rh;
  const lo = side === 'left' ? 1 : side === 'top' ? 1 : Math.round((side === 'right' ? ret.r : ret.b) - INWARD * size);
  const hi = side === 'left' ? Math.round(ret.l + INWARD * size) : side === 'top' ? Math.round(ret.t + INWARD * size) : acrossLen - 2;
  const from = clamp(lo, 1, acrossLen - 2);
  const to = clamp(hi, from, acrossLen - 2);
  const at = (across: number, along: number) => (vertical ? g[along * w + across] : g[across * w + along]);

  const pts: EdgePoint[] = [];
  const all: number[] = [];
  const prof = new Float32Array(acrossLen);
  for (let i = 0; i < LINES; i++) {
    const along = Math.round(a0 + ((a1 - a0) * i) / (LINES - 1));
    if (along < 1 || along > alongLen - 2) continue;
    let max = 0;
    for (let k = from; k <= to; k++) {
      let s = 0;
      for (let d = -1; d <= 1; d++) s += Math.abs(at(k + 1, along + d) - at(k - 1, along + d));
      prof[k] = s / 3;
      if ((k & 3) === 0) all.push(prof[k]); // fürs Grundrauschen reicht jeder vierte Wert
      if (prof[k] > max) max = prof[k];
    }
    const cand: EdgePoint[] = [];
    for (let k = from + 1; k < to; k++) {
      const v = prof[k];
      if (v >= 0.3 * max && v >= prof[k - 1] && v >= prof[k + 1]) cand.push({ across: k, along, strength: v, line: i });
    }
    cand.sort((p, q) => q.strength - p.strength);
    const kept: EdgePoint[] = [];
    for (const c of cand) {
      if (kept.every((o) => Math.abs(o.across - c.across) >= 3)) kept.push(c);
      if (kept.length >= PEAKS) break;
    }
    pts.push(...kept);
  }
  return { pts, noise: Math.max(1, median(all)) };
}

/** Bester Treffer je Suchlinie innerhalb INLIER_PX → Punktzahl und Abdeckung. */
function inliers(pts: EdgePoint[], m: number, c: number): Map<number, EdgePoint> {
  const best = new Map<number, EdgePoint>();
  const norm = Math.sqrt(1 + m * m);
  for (const p of pts) {
    const d = Math.abs(p.across - (m * p.along + c)) / norm;
    if (d > INLIER_PX) continue;
    const cur = best.get(p.line);
    if (!cur || p.strength > cur.strength) best.set(p.line, p);
  }
  return best;
}

function fitLines(pts: EdgePoint[]): Line[] {
  const maxM = Math.tan((MAX_TILT_DEG * Math.PI) / 180);
  const out: Line[] = [];
  // Je Suchlinie der stärkste Treffer — als Array statt Map (läuft für jedes Punktpaar).
  const bestPerLine = new Float32Array(LINES);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const p = pts[i];
      const q = pts[j];
      if (Math.abs(p.line - q.line) < LINES / 3) continue;
      const m = (q.across - p.across) / (q.along - p.along);
      if (!Number.isFinite(m) || Math.abs(m) > maxM) continue;
      const c = p.across - m * p.along;
      const tol = INLIER_PX * Math.sqrt(1 + m * m);
      bestPerLine.fill(0);
      for (const e of pts) {
        if (Math.abs(e.across - (m * e.along + c)) <= tol && e.strength > bestPerLine[e.line]) bestPerLine[e.line] = e.strength;
      }
      let score = 0;
      let hits = 0;
      for (let k = 0; k < LINES; k++) {
        if (bestPerLine[k] > 0) {
          score += bestPerLine[k];
          hits++;
        }
      }
      out.push({ m, c, score, cover: hits / LINES });
    }
  }
  return out;
}

/** Kleinste Quadrate über die Treffer (je Suchlinie einer). */
function refine(pts: EdgePoint[], l: Line): Line {
  const hit = [...inliers(pts, l.m, l.c).values()];
  if (hit.length < 3) return l;
  let sa = 0, sx = 0, saa = 0, sax = 0;
  for (const p of hit) {
    sa += p.along;
    sx += p.across;
    saa += p.along * p.along;
    sax += p.along * p.across;
  }
  const n = hit.length;
  const den = n * saa - sa * sa;
  if (Math.abs(den) < 1e-9) return l;
  const m = (n * sax - sa * sx) / den;
  return { ...l, m, c: (sx - m * sa) / n };
}

/**
 * Die Kante einer Seite: stärkste Gerade, aber eine fast gleich gute, parallele knapp
 * weiter außen gewinnt (Außenkante der Karte statt Innenkante des schwarzen Rands).
 */
function sideLine(g: ArrayLike<number>, w: number, h: number, ret: Rect, side: Side): { line: Line; ratio: number } | null {
  const { pts, noise } = edgePoints(g, w, h, ret, side);
  const lines = fitLines(pts).filter((l) => l.cover >= MIN_COVER);
  if (lines.length === 0) return null;
  lines.sort((a, b) => b.score - a.score);
  const best = lines[0];
  const vertical = side === 'left' || side === 'right';
  const mid = vertical ? (ret.t + ret.b) / 2 : (ret.l + ret.r) / 2;
  const pos = (l: Line) => l.m * mid + l.c;
  const outward = side === 'left' || side === 'top' ? -1 : 1;
  const span = vertical ? ret.r - ret.l : ret.b - ret.t;
  let pick = best;
  for (const l of lines) {
    if (l.score < OUTER_MIN_SHARE * best.score) break;
    const gap = (pos(l) - pos(pick)) * outward;
    if (gap > 2 && gap <= OUTER_MAX_GAP * span && Math.abs(Math.atan(l.m) - Math.atan(best.m)) < (3 * Math.PI) / 180) pick = l;
  }
  const line = refine(pts, pick);
  const hitCount = Math.max(1, Math.round(pick.cover * LINES));
  return { line, ratio: pick.score / hitCount / noise };
}

/** Schnittpunkt einer senkrechten (x = mv·y + cv) und einer waagerechten (y = mh·x + ch) Geraden. */
function intersect(v: Line, hz: Line): Point | null {
  const den = 1 - v.m * hz.m;
  if (Math.abs(den) < 1e-9) return null;
  const x = (v.m * hz.c + v.c) / den;
  return { x, y: hz.m * x + hz.c };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function convex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cross);
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Sucht die Karte als Viereck in `gray` (w×h, 0..255) rund um den Scan-Rahmen `reticle`.
 */
export function findCardQuad(gray: ArrayLike<number>, w: number, h: number, reticle: Rect): QuadResult | null {
  const rw = reticle.r - reticle.l;
  const rh = reticle.b - reticle.t;
  if (w < 16 || h < 16 || rw < 30 || rh < 30) return null;
  const L = sideLine(gray, w, h, reticle, 'left');
  const R = sideLine(gray, w, h, reticle, 'right');
  const T = sideLine(gray, w, h, reticle, 'top');
  const B = sideLine(gray, w, h, reticle, 'bottom');
  if (!L || !R || !T || !B) return null;
  if (Math.min(L.ratio, R.ratio, T.ratio, B.ratio) < MIN_EDGE_RATIO) return null;
  const tl = intersect(L.line, T.line);
  const tr = intersect(R.line, T.line);
  const br = intersect(R.line, B.line);
  const bl = intersect(L.line, B.line);
  if (!tl || !tr || !br || !bl) return null;
  const quad: Quad = [tl, tr, br, bl];
  const slackX = 0.04 * w;
  const slackY = 0.04 * h;
  if (quad.some((p) => p.x < -slackX || p.x > w + slackX || p.y < -slackY || p.y > h + slackY)) return null;
  if (!convex(quad)) return null;
  const top = dist(tl, tr);
  const bottom = dist(bl, br);
  const left = dist(tl, bl);
  const right = dist(tr, br);
  if (Math.max(top, bottom) / Math.min(top, bottom) > MAX_SIDE_RATIO) return null;
  if (Math.max(left, right) / Math.min(left, right) > MAX_SIDE_RATIO) return null;
  const aspect = (top + bottom) / (left + right);
  if (Math.abs(aspect / CARD_ASPECT - 1) > MAX_ASPECT_ERR) return null;
  if ((top + bottom) / 2 < 0.5 * rw || (left + right) / 2 < 0.5 * rh) return null;
  const tilt = (Math.max(...[L, R, T, B].map((s) => Math.abs(Math.atan(s.line.m)))) * 180) / Math.PI;
  const score = (L.ratio + R.ratio + T.ratio + B.ratio) / 4;
  return { quad, tilt: Math.round(tilt * 10) / 10, score: Math.round(score * 10) / 10 };
}

// --- Homographie & Entzerren ------------------------------------------------------------

/** Abbildung Einheitsquadrat (u, v) → Viereck (Heckbert). [a b c d e f g h] */
export function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const hh = (dx1 * sy - sx * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y,
    g, hh,
  ];
}

export function mapPoint(H: readonly number[], u: number, v: number): Point {
  const z = H[6] * u + H[7] * v + 1;
  return { x: (H[0] * u + H[1] * v + H[2]) / z, y: (H[3] * u + H[4] * v + H[5]) / z };
}

/** Ausschnitt in Kartenkoordinaten (0..1); über den Rand hinaus = Karte samt Umgebung. */
export interface UnitBox {
  l: number;
  t: number;
  r: number;
  b: number;
}

export const FULL_CARD: UnitBox = { l: 0, t: 0, r: 1, b: 1 };

/**
 * Karte gerade rechnen: RGBA-Bild (w×h) → RGBA outW×outH, bilinear. `box` wählt den
 * Ausschnitt in Kartenkoordinaten (z. B. etwas größer, wenn die Innenkante gefunden wurde).
 */
export function warpQuad(
  src: ArrayLike<number>, w: number, h: number, quad: Quad, outW: number, outH: number, box: UnitBox = FULL_CARD,
): Uint8ClampedArray<ArrayBuffer> {
  const H = squareToQuad(quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let j = 0; j < outH; j++) {
    const v = box.t + ((j + 0.5) / outH) * (box.b - box.t);
    for (let i = 0; i < outW; i++) {
      const u = box.l + ((i + 0.5) / outW) * (box.r - box.l);
      const p = mapPoint(H, u, v);
      const x = clamp(p.x - 0.5, 0, w - 1);
      const y = clamp(p.y - 0.5, 0, h - 1);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = x - x0;
      const fy = y - y0;
      const o = (j * outW + i) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const a = src[(y0 * w + x0) * 4 + ch];
        const b = src[(y0 * w + x1) * 4 + ch];
        const c = src[(y1 * w + x0) * 4 + ch];
        const d = src[(y1 * w + x1) * 4 + ch];
        out[o + ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return out;
}

/**
 * Ausschnitte fürs Hashen (die 180°-Drehung des ersten kommt im Aufrufer dazu): die Karte
 * selbst und zweimal um den schwarzen Kartenrand größer — auf dunklem Untergrund findet die
 * Suche die Innenkante (wie bei `hashVariantRects`).
 */
export const QUAD_HASH_BOXES: readonly UnitBox[] = [
  FULL_CARD,
  { l: -0.045, t: -0.035, r: 1.045, b: 1.045 },
  { l: -0.045, t: -0.035, r: 1.045, b: 1.085 },
];

/** Ab dieser Schräglage lohnt das Entzerren auch dann, wenn das Rechteck einrastet. */
export const QUAD_MIN_TILT = 1.5;
