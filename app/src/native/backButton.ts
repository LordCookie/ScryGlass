import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { handleBack } from '../ui/backStack';

/**
 * Android-Zurück-Taste abfangen (sonst schließt Capacitor die ganze App). Erst die
 * oberste offene Ebene schließen (ui/backStack); ist nichts offen, die App nur
 * minimieren — Sammlung, Scanner-Zustand und ein laufender Peer-Empfang bleiben.
 * Liefert die Abmeldung (wichtig bei doppelt ausgeführten Effekten im Dev-Modus).
 */
export function initBackButton(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  const handle = App.addListener('backButton', () => {
    if (!handleBack()) void App.minimizeApp().catch(() => {});
  });
  return () => void handle.then((h) => h.remove()).catch(() => {});
}
