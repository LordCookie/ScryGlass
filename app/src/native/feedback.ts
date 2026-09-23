import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/**
 * Rückmeldung beim Scannen: native Vibration (Capacitor Haptics — die Browser-
 * `navigator.vibrate` verpufft in der Android-WebView ohne VIBRATE-Berechtigung)
 * und ein kurzer, selbst erzeugter Ton (Web Audio, keine Sounddatei).
 * Alles best effort: Feedback darf den Scanner nie stören.
 */

const native = Capacitor.isNativePlatform();
let audio: AudioContext | null = null;

/** Audio freischalten — muss aus einer Nutzer-Geste heraus passieren (z. B. Kamera starten). */
export function unlockAudio(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    audio = null;
  }
}

/** Kurzer „Pling": zwei schnelle Töne mit weicher Hüllkurve (kein Knacksen). */
function beep(): void {
  if (!audio) return;
  try {
    const t0 = audio.currentTime;
    for (const [freq, start] of [[880, 0], [1320, 0.07]] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.09);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + 0.1);
    }
  } catch {
    /* kein Ton — egal */
  }
}

/** Leichtes Antippen-Feedback für Knöpfe. */
export function hapticTap(): void {
  if (native) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  else navigator.vibrate?.(10);
}

/** Karte ist im Korb: spürbare Vibration + optional Ton. */
export function feedbackAdded(sound: boolean): void {
  if (native) void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
  else navigator.vibrate?.(30);
  if (sound) {
    if (!audio) unlockAudio(); // z. B. manuell hinzugefügt, ohne vorher die Kamera zu starten
    beep();
  }
}
