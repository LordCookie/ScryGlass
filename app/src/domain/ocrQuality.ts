/**
 * OCR-Qualität (bessere Texterkennung, Tier 2 light). Framework-frei & rein testbar.
 *
 * Der Scanner liest den Titelbalken in zwei Varianten (Graustufe + Schwarzweiß) und
 * nimmt die Lesung mit der höheren Tesseract-Sicherheit. Diese Sicherheit fließt
 * zusätzlich in die Fusion: Bei unsicherer Lesung darf OCR allein keine Karte mehr
 * automatisch übernehmen — ein Bild bestätigen (Kreuz-Bestätigung) aber schon.
 */

export interface OcrRead {
  text: string;
  /** Tesseract-Sicherheit 0..100. */
  confidence: number;
}

/** Unter dieser Tesseract-Sicherheit gilt eine Lesung als unsicher (per Protokoll tunen). */
export const OCR_CONF_MIN = 55;
/** Deckel für den Match-Score unsicherer Lesungen: unter `ocrConfident` (0.85), über `ocrConfirm` (0.6). */
export const OCR_LOW_CONF_CAP = 0.8;

/** Beste Lesung = höchste Sicherheit; leere Lesungen zählen nicht. */
export function pickBestRead(reads: readonly OcrRead[]): OcrRead {
  let best: OcrRead = { text: '', confidence: 0 };
  for (const r of reads) {
    if (!r.text.trim()) continue;
    if (!best.text || r.confidence > best.confidence) best = r;
  }
  return best;
}

/** Effektiver OCR-Score für die Fusion (unsichere Lesung → gedeckelt). */
export function ocrEffectiveScore(
  matchScore: number,
  tessConfidence: number,
  confMin = OCR_CONF_MIN,
  cap = OCR_LOW_CONF_CAP,
): number {
  return tessConfidence >= confMin ? matchScore : Math.min(matchScore, cap);
}
