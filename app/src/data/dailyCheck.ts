import { Capacitor } from '@capacitor/core';
import { getMeta, setMeta } from '../db/db';
import { getLocalCatalogVersion } from './catalog';
import { UpdateNotifier } from '../native/updateNotifier';

/**
 * Täglicher Update-Blick (PLAN.md M23): Einstellung unter Mehr → Updates (Standard: an).
 * Das Nachsehen selbst macht Android im Hintergrund (UpdateNotifier.kt); hier nur an/aus,
 * die Erlaubnis für Benachrichtigungen und der eingespielte Katalogstand zum Vergleichen.
 */

const KEY = 'dailyUpdateCheck';
const ASKED = 'notifyPermissionAsked';

export function dailyCheckAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function dailyCheckEnabled(): Promise<boolean> {
  return (await getMeta<boolean>(KEY)) ?? true;
}

/** Stand an Android weitergeben (nach dem Start und nach jedem Katalog-Update). */
export async function syncDailyCheck(): Promise<void> {
  if (!dailyCheckAvailable()) return;
  const [enabled, catalogVersion] = await Promise.all([dailyCheckEnabled(), getLocalCatalogVersion()]);
  await UpdateNotifier.configure({ enabled, ...(catalogVersion ? { catalogVersion } : {}) });
}

/** Beim Start: einmal nach der Erlaubnis fragen (Android 13+), dann planen. */
export async function initDailyCheck(): Promise<void> {
  if (!dailyCheckAvailable()) return;
  if ((await dailyCheckEnabled()) && !(await getMeta<boolean>(ASKED))) {
    await setMeta(ASKED, true);
    await UpdateNotifier.requestPermission().catch(() => null);
  }
  await syncDailyCheck();
}

/** Schalter: an → Erlaubnis holen; gibt zurück, ob Benachrichtigungen erlaubt sind. */
export async function setDailyCheck(on: boolean): Promise<boolean> {
  await setMeta(KEY, on);
  let granted = true;
  if (on && dailyCheckAvailable()) granted = (await UpdateNotifier.requestPermission().catch(() => ({ granted: false }))).granted;
  await syncDailyCheck();
  return granted;
}

/** Über die Benachrichtigung geöffnet (beim Start oder während die App lief)? */
export async function watchUpdateLaunch(open: () => void): Promise<() => void> {
  if (!dailyCheckAvailable()) return () => {};
  const r = await UpdateNotifier.consumeLaunch().catch(() => ({ openUpdates: false }));
  if (r.openUpdates) open();
  const h = await UpdateNotifier.addListener('openUpdates', open);
  return () => void h.remove();
}
