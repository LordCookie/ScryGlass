import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Brücke zum nativen Plugin `BigScreen` (android/…/BigScreenPlugin.kt, PLAN.md M18):
 * HTTP-/WebSocket-Server, der die App an den Browser ausliefert, und der Wachmodus.
 */
export interface BigScreenPlugin {
  start(opts: { ports?: number[]; deviceName: string; appVersion: string }): Promise<{ url: string; ip: string; port: number }>;
  stop(): Promise<void>;
  respond(opts: { id: string; status: number; body: string; headers?: Record<string, string> }): Promise<void>;
  send(opts: { data: string; sessions?: string[] }): Promise<void>;
  close(opts: { sessions: string[]; data?: string }): Promise<void>;
  /** Bildschirm an + WLAN-Lock; `dim` = Ruhebild (Helligkeit nur für das App-Fenster). */
  setAwake(opts: { on: boolean; dim?: boolean }): Promise<void>;
  battery(): Promise<{ level?: number; charging?: boolean }>;
  getIp(): Promise<{ ip: string }>;
  /** Ordner, aus dem `/catalog/*` zuerst ausgeliefert wird (aufgehobene Katalog-Dateien). */
  catalogPath(): Promise<{ path: string }>;
  /** Gültige Sitzungs-Cookies — nur sie bekommen Kartenbilder über `/img` (M20). */
  setSessions(opts: { tokens: string[] }): Promise<void>;
  /** Bild-Zwischenspeicher für den Browser: Größe und Anzahl. */
  imageCache(): Promise<{ bytes: number; count: number }>;
  clearImageCache(): Promise<void>;
  addListener(
    eventName: 'request',
    cb: (req: { id: string; method: string; path: string; cookie?: string; body?: string; remote?: string; userAgent?: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: 'socketOpen' | 'socketClose', cb: (e: { socket: string; session: string }) => void): Promise<PluginListenerHandle>;
}

export const BigScreen = registerPlugin<BigScreenPlugin>('BigScreen');
