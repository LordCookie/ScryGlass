import { Capacitor, registerPlugin, CapacitorHttp, type PluginListenerHandle } from '@capacitor/core';

/**
 * Brücke zum nativen Kotlin-Plugin `PeerServer` (PLAN.md § 8) und zu `CapacitorHttp`.
 * CapacitorHttp geht nativ raus und umgeht so Mixed-Content/CORS beim Request auf
 * `http://192.168.…` (Android-Fallstrick, § 8).
 *
 * Im Browser/Dev (kein Capacitor) laufen die HTTP-Helfer über `fetch` — cross-LAN
 * erreicht das ein echtes Gerät nicht, aber die App baut und die UI funktioniert.
 */

export interface PeerServerPlugin {
  /** Startet den HTTP-Server; liefert die erreichbare URL + gewählten Port. */
  start(options: { token: string; port: number }): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  getLocalIp(): Promise<{ ip: string }>;
  /** Feuert bei jedem eingehenden Korb (Body als JSON-String). */
  addListener(
    eventName: 'basketReceived',
    cb: (event: { data: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const PeerServer = registerPlugin<PeerServerPlugin>('PeerServer');

export const isNative = Capacitor.isNativePlatform();

export interface HttpResult<T> {
  status: number;
  data: T;
}

export async function httpGetJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 5000,
): Promise<HttpResult<T>> {
  if (isNative) {
    const res = await CapacitorHttp.request({ url, method: 'GET', headers, connectTimeout: timeoutMs });
    return { status: res.status, data: res.data as T };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

export async function httpPostJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 8000,
): Promise<HttpResult<T>> {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (isNative) {
    const res = await CapacitorHttp.request({ url, method: 'POST', headers: h, data: body, connectTimeout: timeoutMs });
    return { status: res.status, data: res.data as T };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal });
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}
