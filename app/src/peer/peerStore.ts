import { getMeta, setMeta } from '../db/db';

/**
 * Verbindungs-/Gerätezustand fürs Peer-Scanning (PLAN.md § 8). Rollen sind NICHT
 * persistent — verbundene Peers leben nur zur Laufzeit (Token wechselt pro Session).
 * Geräte-ID/-Name sind persistent (für Dedup & Anzeige).
 */

export interface PeerConn {
  deviceName: string;
  /** Basis-URL, z. B. http://192.168.1.42:8765 */
  url: string;
  token: string;
}

/** Ziel eines Scans (PLAN.md § 8, „Das Scan-Ziel"). */
export type ScanTarget = { kind: 'local' } | ({ kind: 'peer' } & PeerConn);

let peers: PeerConn[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPeers(): readonly PeerConn[] {
  return peers;
}

export function addPeer(conn: PeerConn): void {
  peers = [...peers.filter((p) => p.url !== conn.url), conn];
  emit();
}

export function removePeer(url: string): void {
  peers = peers.filter((p) => p.url !== url);
  emit();
}

// --- Geräteidentität (persistent) -------------------------------------------

const DEVICE_ID_KEY = 'deviceId';
const DEVICE_NAME_KEY = 'deviceName';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function getDeviceId(): Promise<string> {
  let id = await getMeta<string>(DEVICE_ID_KEY);
  if (!id) {
    id = randomId();
    await setMeta(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function getDeviceName(): Promise<string> {
  return (await getMeta<string>(DEVICE_NAME_KEY)) ?? 'Mein Handy';
}

export async function setDeviceName(name: string): Promise<void> {
  await setMeta(DEVICE_NAME_KEY, name.trim() || 'Mein Handy');
}
