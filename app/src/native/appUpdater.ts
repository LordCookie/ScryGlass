import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Brücke zum nativen Plugin `AppUpdater` (android/…/AppUpdaterPlugin.kt, M15): prüft eine
 * heruntergeladene APK (Prüfsumme, Paket, Version, Signatur) und öffnet den Installer.
 * Fehler kommen mit `code`: PRUEFSUMME, SIGNATUR, NICHT_NEUER, PAKET, APK, ERLAUBNIS,
 * ALT, PFAD, FEHLER.
 */
export interface AppUpdaterPlugin {
  /** Darf die App installieren (Android 8+: einmal pro App erlauben)? `supported`: Android 7+. */
  canInstall(): Promise<{ allowed: boolean; supported: boolean }>;
  /** Systemeinstellung „Unbekannte Apps installieren" für ScryGlass öffnen. */
  openInstallSettings(): Promise<void>;
  install(opts: { path: string; sha256: string }): Promise<void>;
  /** Bildschirm anlassen (FLAG_KEEP_SCREEN_ON), solange ein Update lädt. */
  keepScreenOn(opts: { on: boolean }): Promise<void>;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

/** Nur die Android-App kann sich selbst aktualisieren. */
export function hasAppUpdater(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

let screenOnHolds = 0;

/** `work` mit angelassenem Bildschirm ausführen — sonst bremst Android die WebView aus,
 *  sobald er ausgeht. Mehrere gleichzeitig (Katalog + App-Update) zählen mit. */
export async function withScreenOn<T>(work: () => Promise<T>): Promise<T> {
  if (!hasAppUpdater()) return work();
  if (screenOnHolds++ === 0) await AppUpdater.keepScreenOn({ on: true }).catch(() => {});
  try {
    return await work();
  } finally {
    if (--screenOnHolds === 0) await AppUpdater.keepScreenOn({ on: false }).catch(() => {});
  }
}
