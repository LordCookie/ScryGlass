/**
 * Fusion von OCR- und Bild-Signal für den Scanner (Tier 1, robuster Scanner).
 * Framework-frei & rein testbar (CLAUDE.md): entscheidet, welche Karte oben steht,
 * ob sie sicher genug für die Auto-Übernahme ist, und ob OCR und Bild sich
 * gegenseitig bestätigen (das stärkste Signal überhaupt).
 *
 * Prioritätsreihenfolge (bewusst wie bisher „Bild vor OCR", plus Kreuz-Bestätigung
 * ganz oben):
 *   1. agree  — OCR-Bester == Bild-Bester (Bild im lockeren Confirm-Gate) → sicher
 *   2. bild   — Bildtreffer im Anzeige-Gate; sicher nur, wenn „stark"
 *   3. ocr    — OCR-Bester; sicher nur bei hohem Score und nicht mehrdeutig
 *   4. none   — nichts Brauchbares
 */

export interface OcrSignal {
  oracleId?: string;
  score: number; // 0..1
  ambiguous: boolean;
}

export interface HashSignal {
  oracleId: string;
  distance: number; // 0..256 (klein = besser)
  margin: number; // Abstand zur nächsten FREMDEN Karte (groß = eindeutig)
}

export interface FuseConfig {
  hashMaxDist: number; // Bild als Kandidat zeigen
  hashMinMargin: number;
  hashAutoDist: number; // Bild allein stark genug für Auto-Übernahme
  hashAutoMargin: number;
  hashConfirmDist: number; // lockereres Gate, wenn OCR dieselbe Karte bestätigt
  hashConfirmMargin: number;
  ocrConfident: number; // OCR allein sicher (z. B. 0.85)
  ocrConfirm: number; // OCR zählt als Bestätigung (z. B. 0.6)
}

export type FuseMethod = 'bild+ocr' | 'bild' | 'ocr' | 'none';

export interface FuseResult {
  method: FuseMethod;
  oracleId?: string;
  /** OCR und Bild zeigen dieselbe Karte. */
  agree: boolean;
  /** Reif für Auto-Übernahme (vor dem zeitlichen Konsens). */
  confident: boolean;
  /** Nur den Bildtreffer anzeigen (OCR-Rauschen unterdrücken). */
  showAlone: boolean;
  /** 0..1 Anzeige-Confidence. */
  score: number;
}

function imageScore(distance: number): number {
  return Math.max(0.5, 1 - distance / 128);
}

export function fuseScan(ocr: OcrSignal, hash: HashSignal | null, cfg: FuseConfig): FuseResult {
  const hashShown =
    hash && hash.distance <= cfg.hashMaxDist && hash.margin >= cfg.hashMinMargin ? hash : null;
  const hashStrong =
    !!hashShown && hashShown.distance <= cfg.hashAutoDist && hashShown.margin >= cfg.hashAutoMargin;

  // Kreuz-Bestätigung: dieselbe Karte aus OCR UND Bild — Bild darf hier lockerer sein,
  // weil OCR unabhängig dieselbe oracleId liefert (Doppel-Fehler auf dieselbe Karte
  // ist praktisch ausgeschlossen).
  const agree =
    !!hash &&
    !!ocr.oracleId &&
    hash.oracleId === ocr.oracleId &&
    hash.distance <= cfg.hashConfirmDist &&
    hash.margin >= cfg.hashConfirmMargin &&
    ocr.score >= cfg.ocrConfirm;

  if (agree) {
    return { method: 'bild+ocr', oracleId: hash!.oracleId, agree: true, confident: true, showAlone: false, score: 0.99 };
  }
  if (hashShown) {
    return {
      method: 'bild',
      oracleId: hashShown.oracleId,
      agree: false,
      confident: hashStrong,
      showAlone: hashStrong,
      score: imageScore(hashShown.distance),
    };
  }
  if (ocr.oracleId) {
    const ocrConfident = ocr.score >= cfg.ocrConfident && !ocr.ambiguous;
    return { method: 'ocr', oracleId: ocr.oracleId, agree: false, confident: ocrConfident, showAlone: false, score: ocr.score };
  }
  return { method: 'none', agree: false, confident: false, showAlone: false, score: 0 };
}
