import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { TextLine } from '../domain/cardText';

/**
 * Brücke zum nativen Kotlin-Plugin `ScryCamera` (android/…/ScryCameraPlugin.kt):
 * CameraX-Vorschau hinter der transparenten WebView + ML-Kit-Texterkennung auf dem
 * Gerät. Liefert pro ausgewertetem Bild ein `frame`-Event. Im Browser nicht vorhanden
 * — dort bleibt der Scanner bei getUserMedia + Tesseract.
 */

/** Rechteck normiert auf die WebView (0..1). */
export interface ReticleRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeFrame {
  /** Bild zu unscharf → keine Texterkennung gelaufen. */
  blurry: boolean;
  sharpness: number;
  /** Textzeilen mit Position relativ zum Kartenausschnitt. */
  lines?: TextLine[];
  /** Kartenausschnitt 146×204 als JPEG (Base64) — für den Bild-Hash. */
  crop?: string;
  /** QR-Modus: quadratischer Ausschnitt (JPEG, Base64) fürs Pairing — jsQR dekodiert in JS. */
  qr?: string;
}

export type CameraMode = 'card' | 'qr';

export interface ScryCameraPlugin {
  start(options: ReticleRect & { mode?: CameraMode }): Promise<{ torch: boolean; zoomMin?: number; zoomMax?: number }>;
  /** Zwischen Karten-Scan und QR-Pairing umschalten (Kamera läuft weiter). */
  setMode(options: { mode: CameraMode }): Promise<void>;
  stop(): Promise<void>;
  setReticle(options: ReticleRect): Promise<void>;
  focus(options: { x: number; y: number }): Promise<void>;
  setTorch(options: { on: boolean }): Promise<void>;
  setZoom(options: { ratio: number }): Promise<void>;
  addListener(eventName: 'frame', cb: (frame: NativeFrame) => void): Promise<PluginListenerHandle>;
}

export const ScryCamera = registerPlugin<ScryCameraPlugin>('ScryCamera');

/** Native Kamera nutzbar? (nur in der Android-App mit registriertem Plugin) */
export function hasNativeCamera(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ScryCamera');
}

/** Rechteck eines Elements, normiert auf das Browserfenster (= WebView). */
export function reticleOf(el: Element): ReticleRect {
  const r = el.getBoundingClientRect();
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  return { left: r.left / w, top: r.top / h, width: r.width / w, height: r.height / h };
}
