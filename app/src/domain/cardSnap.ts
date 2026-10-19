/**
 * Karte einrasten (PLAN.md § 6.2, Schritt 3). Der Scanner liefert einen Ausschnitt mit
 * etwas Luft um den Scan-Rahmen; hier werden darin die vier Kartenkanten gesucht, damit
 * der Bild-Hash genau die Karte sieht — auch wenn sie kleiner als der Rahmen ist oder
 * versetzt liegt. Framework-frei & rein testbar (Graustufen-Array rein, Rechteck raus).
 *
 * Vorgehen: Kantenprofile (Helligkeitssprung je Spalte/Zeile, nur über das mittlere
 * Drittel der Gegenseite, damit Ecken/Nachbarkarten weniger stören) → je Seite die
 * stärksten Kandidaten → die Kombination, die ein Rechteck im Kartenformat ergibt und
 * deren Kanten sich klar vom Grundrauschen abheben. Innere Linien (Bild-/Textkasten)
 * fallen über das Seitenverhältnis heraus. Findet sich nichts Überzeugendes, bleibt
 * der Rahmen (kein Rätselraten).
 */

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface SnapResult {
  rect: Rect;
  /** Kanten gefunden (sonst = Rahmen) */
  snapped: boolean;
  /** mittlere Kantenstärke relativ zum Grundrauschen (Diagnose) */
  score: number;
}

export const CARD_ASPECT = 745 / 1040;

/** Profil nur über die mittleren 60 % der Gegenseite (20 % Rand je Seite weglassen). */
const BAND = 0.2;
/** Die Karte darf je Seite bis zu 30 % innerhalb des Rahmens liegen. */
const INWARD = 0.3;
/** kleinste Kartengröße relativ zum Rahmen */
const MIN_SIZE = 0.5;
/** erlaubte Abweichung vom Kartenformat */
const MAX_ASPECT_ERR = 0.08;
/** jede Kante muss sich so deutlich vom Grundrauschen abheben … */
const MIN_SIDE_RATIO = 1.8;
/** … und im Mittel so deutlich */
const MIN_AVG_RATIO = 2.4;
/** Kandidaten je Seite */
const PEAKS = 4;
/** Grundrauschen nie unter einer Graustufe ansetzen (glatte Flächen) */
const NOISE_FLOOR = 1;
/**
 * Außerhalb einer echten Kartenkante ist es ruhig (Tisch, schwarzer Rand). Liegt
 * innerhalb von QUIET_BAND (Anteil der Rahmengröße) noch eine Kante mit mehr als
 * QUIET_MAX der Stärke, war es eine innere Linie (Bild-/Textkasten, Innenrand).
 */
const QUIET_BAND = 0.1;
const QUIET_MAX = 0.6;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Helligkeitssprung je Spalte x (|g(x+1) − g(x−1)|), gemittelt über die Zeilen y0..y1. */
function colProfile(g: ArrayLike<number>, w: number, y0: number, y1: number): Float32Array {
  const p = new Float32Array(w);
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) p[x] += Math.abs(g[row + x + 1] - g[row + x - 1]);
  }
  const n = y1 - y0 + 1;
  for (let x = 0; x < w; x++) p[x] /= n;
  return p;
}

/** Helligkeitssprung je Zeile y (|g(y+1) − g(y−1)|), gemittelt über die Spalten x0..x1. */
function rowProfile(g: ArrayLike<number>, w: number, h: number, x0: number, x1: number): Float32Array {
  const p = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    let s = 0;
    const up = (y - 1) * w;
    const down = (y + 1) * w;
    for (let x = x0; x <= x1; x++) s += Math.abs(g[down + x] - g[up + x]);
    p[y] = s / (x1 - x0 + 1);
  }
  return p;
}

function median(p: Float32Array, from: number, to: number): number {
  const a = Array.from(p.subarray(from, to + 1)).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}

/** Ist es außerhalb der Kante bei `pos` ruhig? `dir` −1 = außen liegt links/oben. */
function quietOutside(p: Float32Array, pos: number, dir: -1 | 1, band: number): boolean {
  let max = 0;
  for (let k = 3; k <= band; k++) {
    const i = pos + dir * k;
    if (i < 1 || i > p.length - 2) break;
    if (p[i] > max) max = p[i];
  }
  return max <= QUIET_MAX * p[pos];
}

/**
 * Lokale Maxima im Bereich [from, to], stärkste zuerst, Mindestabstand 3 — nur solche,
 * hinter denen (Richtung `dir`, nach außen) keine weitere starke Kante kommt.
 */
function peaks(p: Float32Array, from: number, to: number, dir: -1 | 1, band: number): { pos: number; val: number }[] {
  const cand: { pos: number; val: number }[] = [];
  for (let i = Math.max(1, from); i <= Math.min(p.length - 2, to); i++) {
    if (p[i] > 0 && p[i] >= p[i - 1] && p[i] >= p[i + 1] && quietOutside(p, i, dir, band)) cand.push({ pos: i, val: p[i] });
  }
  cand.sort((a, b) => b.val - a.val);
  const out: { pos: number; val: number }[] = [];
  for (const c of cand) {
    if (out.every((o) => Math.abs(o.pos - c.pos) >= 3)) out.push(c);
    if (out.length >= PEAKS) break;
  }
  return out;
}

/**
 * Sucht die Karte in `gray` (w×h, Helligkeit 0..255, zeilenweise) rund um den
 * Scan-Rahmen `reticle` (Pixel). Liefert das Kartenrechteck oder den Rahmen.
 */
export function snapCard(gray: ArrayLike<number>, w: number, h: number, reticle: Rect): SnapResult {
  const fallback: SnapResult = { rect: reticle, snapped: false, score: 0 };
  const rw = reticle.r - reticle.l;
  const rh = reticle.b - reticle.t;
  if (w < 8 || h < 8 || rw < 20 || rh < 20) return fallback;

  const y0 = clamp(Math.round(reticle.t + BAND * rh), 1, h - 2);
  const y1 = clamp(Math.round(reticle.b - BAND * rh), y0, h - 2);
  const x0 = clamp(Math.round(reticle.l + BAND * rw), 1, w - 2);
  const x1 = clamp(Math.round(reticle.r - BAND * rw), x0, w - 2);
  const col = colProfile(gray, w, y0, y1);
  const row = rowProfile(gray, w, h, x0, x1);
  const colNoise = Math.max(NOISE_FLOOR, median(col, 1, w - 2));
  const rowNoise = Math.max(NOISE_FLOOR, median(row, 1, h - 2));

  const bandX = Math.max(4, Math.round(QUIET_BAND * rw));
  const bandY = Math.max(4, Math.round(QUIET_BAND * rh));
  const L = peaks(col, 1, Math.round(reticle.l + INWARD * rw), -1, bandX);
  const R = peaks(col, Math.round(reticle.r - INWARD * rw), w - 2, 1, bandX);
  const T = peaks(row, 1, Math.round(reticle.t + INWARD * rh), -1, bandY);
  const B = peaks(row, Math.round(reticle.b - INWARD * rh), h - 2, 1, bandY);

  let best: { rect: Rect; score: number; avg: number } | null = null;
  for (const l of L) {
    for (const r of R) {
      const width = r.pos - l.pos;
      if (width < MIN_SIZE * rw) continue;
      for (const t of T) {
        for (const b of B) {
          const height = b.pos - t.pos;
          if (height < MIN_SIZE * rh) continue;
          const err = Math.abs(width / height / CARD_ASPECT - 1);
          if (err > MAX_ASPECT_ERR) continue;
          const ratios = [l.val / colNoise, r.val / colNoise, t.val / rowNoise, b.val / rowNoise];
          if (Math.min(...ratios) < MIN_SIDE_RATIO) continue;
          const avg = (ratios[0] + ratios[1] + ratios[2] + ratios[3]) / 4;
          // Leicht den Rahmen bevorzugen (dahin zielt man) und das exakte Kartenformat.
          const dev =
            (Math.abs(l.pos - reticle.l) + Math.abs(r.pos - reticle.r) + Math.abs(t.pos - reticle.t) + Math.abs(b.pos - reticle.b)) /
            (rw + rh);
          const score = avg * (1 - 3 * err - dev);
          if (!best || score > best.score) best = { rect: { l: l.pos, t: t.pos, r: r.pos, b: b.pos }, score, avg };
        }
      }
    }
  }
  if (!best || best.avg < MIN_AVG_RATIO) return fallback;
  return { rect: best.rect, snapped: true, score: Math.round(best.avg * 10) / 10 };
}

/**
 * Ausschnitte für den Bild-Hash (die 180°-Drehung des ersten kommt im Aufrufer dazu):
 * das Rechteck selbst und je nach Lage
 * - eingerastet: in jede Ecke um 7 % geschrumpft — fängt Stapel ab, bei denen die
 *   vorherige Karte hervorschaut und das umschließende Rechteck gewählt wurde; dazu
 *   zweimal um den schwarzen Kartenrand vergrößert — auf dunklem Untergrund rastet die
   *   Suche am Innenrand ein (seitlich/oben ~4 %, unten 4–8 % zu klein);
 * - nicht eingerastet (Rahmen): 5 % enger und um 4 % nach links/rechts/oben/unten
 *   verschoben.
 * (Gemessen mit echten Kartenbildern: „5 % enger" gewinnt nach dem Einrasten nie.)
 */
export function hashVariantRects(r: Rect, snapped: boolean): Rect[] {
  const w = r.r - r.l;
  const h = r.b - r.t;
  const out: Rect[] = [r];
  if (!snapped) out.push({ l: r.l + 0.05 * w, t: r.t + 0.05 * h, r: r.r - 0.05 * w, b: r.b - 0.05 * h });
  if (snapped) {
    const sx = 0.07 * w;
    const sy = 0.07 * h;
    out.push(
      { l: r.l, t: r.t, r: r.r - sx, b: r.b - sy },
      { l: r.l + sx, t: r.t, r: r.r, b: r.b - sy },
      { l: r.l, t: r.t + sy, r: r.r - sx, b: r.b },
      { l: r.l + sx, t: r.t + sy, r: r.r, b: r.b },
      { l: r.l - 0.045 * w, t: r.t - 0.035 * h, r: r.r + 0.045 * w, b: r.b + 0.045 * h },
      { l: r.l - 0.045 * w, t: r.t - 0.035 * h, r: r.r + 0.045 * w, b: r.b + 0.085 * h },
    );
  } else {
    const dx = 0.04 * w;
    const dy = 0.04 * h;
    out.push(
      { l: r.l - dx, t: r.t, r: r.r - dx, b: r.b },
      { l: r.l + dx, t: r.t, r: r.r + dx, b: r.b },
      { l: r.l, t: r.t - dy, r: r.r, b: r.b - dy },
      { l: r.l, t: r.t + dy, r: r.r, b: r.b + dy },
    );
  }
  return out;
}
