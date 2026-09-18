import { KeepAwake } from '@capacitor-community/keep-awake';
import type { PluginListenerHandle } from '@capacitor/core';
import { PeerServer, isNative } from './nativeBridge';
import { buildPairingUrl, generateToken, PEER_PORT_FALLBACKS, type BasketPayload } from './protocol';
import { db, putInboxBasket, getMeta } from '../db/db';
import { getDeviceName } from './peerStore';

/**
 * Empfänger-Seite (PLAN.md § 8). „Empfangen" ist ein Ein-/Ausschalter, kein
 * globaler App-Modus. Der native Server läuft im Hintergrund; eingehende Körbe
 * landen im `inbox` (Badge, kein Dialog, der den eigenen Scan unterbricht).
 *
 * KeepAwake während der Session (billiger als ein Foreground-Service, § 8).
 * Port-Fallback 8765 → 8766 → 8767 (der gewählte Port steht im QR).
 */

export interface ReceiverState {
  running: boolean;
  url?: string;
  port?: number;
  token?: string;
  ip?: string;
  qr?: string;
  error?: string;
}

let listener: PluginListenerHandle | null = null;
let current: ReceiverState = { running: false };
const subs = new Set<(s: ReceiverState) => void>();
const inboxSubs = new Set<() => void>();

function set(next: ReceiverState) {
  current = next;
  for (const f of subs) f(next);
}

export function receiverState(): ReceiverState {
  return current;
}

export function subscribeReceiver(cb: (s: ReceiverState) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => subs.delete(cb);
}

/** Benachrichtigung, wenn ein neuer Korb eingegangen ist (fürs Inbox-Badge). */
export function subscribeInbox(cb: () => void): () => void {
  inboxSubs.add(cb);
  return () => inboxSubs.delete(cb);
}

async function onBasket(json: string): Promise<void> {
  try {
    const p = JSON.parse(json) as BasketPayload;
    await putInboxBasket({
      basketId: p.basketId,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      createdAt: p.createdAt,
      receivedAt: Date.now(),
      status: 'received',
      entries: p.entries,
    });
    for (const f of inboxSubs) f();
  } catch {
    /* kaputter Korb wird ignoriert (der Sender kann per Notausgang/Export nachliefern) */
  }
}

export async function startReceiver(): Promise<ReceiverState> {
  if (!isNative) {
    set({ running: false, error: 'Empfangen geht nur in der installierten App (nativer HTTP-Server).' });
    return current;
  }
  const token = generateToken();
  const [name, catalogVersion, cardCount] = await Promise.all([
    getDeviceName(),
    getMeta<string>('catalogVersion').then((v) => v ?? ''),
    db.cards.count(),
  ]);
  try {
    listener = await PeerServer.addListener('basketReceived', (e) => void onBasket(e.data));
  } catch {
    /* Listener optional — der Server pusht sonst nichts, aber Start soll nicht scheitern */
  }

  let started: { url: string; port: number } | null = null;
  for (const port of PEER_PORT_FALLBACKS) {
    try {
      started = await PeerServer.start({ token, port, deviceName: name, catalogVersion, cardCount });
      break;
    } catch {
      /* Port belegt → nächster */
    }
  }
  if (!started) {
    set({ running: false, error: 'Server konnte nicht starten (Ports 8765–8767 belegt?).' });
    return current;
  }

  let host = started.url;
  try {
    host = new URL(started.url).hostname;
  } catch {
    /* url ohne Protokoll — dann roh nehmen */
  }
  const qr = buildPairingUrl({ host, port: started.port, token, name });
  try {
    await KeepAwake.keepAwake();
  } catch {
    /* KeepAwake optional */
  }
  set({ running: true, url: started.url, port: started.port, token, ip: host, qr });
  return current;
}

export async function stopReceiver(): Promise<void> {
  try {
    await listener?.remove();
  } catch {
    /* egal */
  }
  listener = null;
  try {
    await PeerServer.stop();
  } catch {
    /* egal */
  }
  try {
    await KeepAwake.allowSleep();
  } catch {
    /* egal */
  }
  set({ running: false });
}
