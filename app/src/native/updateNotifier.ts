import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Brücke zum täglichen Update-Blick (android/…/UpdateNotifierPlugin.kt, PLAN.md M23):
 * gegen 12 Uhr bei GitHub nachsehen und per Benachrichtigung Bescheid geben.
 */
export interface UpdateNotifierPlugin {
  /** an/aus und der eingespielte Katalogstand (zum Vergleichen im Hintergrund) */
  configure(opts: { enabled: boolean; catalogVersion?: string }): Promise<void>;
  /** Android 13+: Erlaubnis für Benachrichtigungen (vorher immer erlaubt) */
  requestPermission(): Promise<{ granted: boolean }>;
  /** Wurde die App über die Update-Benachrichtigung geöffnet? */
  consumeLaunch(): Promise<{ openUpdates: boolean }>;
  addListener(eventName: 'openUpdates', cb: () => void): Promise<PluginListenerHandle>;
}

export const UpdateNotifier = registerPlugin<UpdateNotifierPlugin>('UpdateNotifier');
