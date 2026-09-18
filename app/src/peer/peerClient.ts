import { httpGetJson, httpPostJson } from './nativeBridge';
import {
  baseUrl,
  isProtocolCompatible,
  type BasketAck,
  type BasketPayload,
  type HelloResponse,
  type PairingInfo,
  type StatusResponse,
} from './protocol';
import { addPeer, type PeerConn } from './peerStore';

/**
 * Sender-Seite des Peer-Scannings (PLAN.md § 8). „Senden" ist kein App-Modus,
 * sondern ein Ziel am Scanner — der Korb wird per HTTP POST an den Empfänger
 * geschoben. Der Sender löscht nichts beim Senden; erst nach ACK gilt der Korb als
 * bestätigt (Zuverlässigkeit, § 8).
 */

export class PeerError extends Error {}

/** Pairing: Handshake mit dem Empfänger, Versionen prüfen, Peer merken. */
export async function pair(info: PairingInfo): Promise<{ hello: HelloResponse; conn: PeerConn }> {
  const url = baseUrl(info.host, info.port);
  let hello: HelloResponse;
  try {
    const res = await httpGetJson<HelloResponse>(`${url}/hello`, {}, 4000);
    if (res.status !== 200) throw new PeerError(`Empfänger antwortet mit ${res.status}.`);
    hello = res.data;
  } catch (e) {
    throw new PeerError(
      'Verbindung fehlgeschlagen. Gleiches WLAN? Manche Gäste-Netze trennen Geräte ab — dann Hotspot des Empfängers nutzen.' +
        (e instanceof Error ? ` (${e.message})` : ''),
    );
  }
  if (!isProtocolCompatible(hello)) {
    throw new PeerError('Andere Protokoll-Version — bitte beide Apps aktualisieren.');
  }
  const conn: PeerConn = { deviceName: hello.deviceName, url, token: info.token };
  addPeer(conn);
  return { hello, conn };
}

/**
 * Korb senden. `409` (basketId schon vorhanden) ist KEIN Fehler — idempotent, der
 * Empfänger hat ihn bereits (§ 8). `401` = falscher Token.
 */
export async function sendBasket(conn: PeerConn, payload: BasketPayload): Promise<BasketAck> {
  const res = await httpPostJson<BasketAck>(`${conn.url}/basket`, payload, {
    'X-Session-Token': conn.token,
  });
  if (res.status === 401) throw new PeerError('Token abgelehnt — Empfänger zeigt den aktuellen Token an.');
  if (res.status === 409) return { accepted: payload.entries.length, basketId: payload.basketId };
  if (res.status !== 200) throw new PeerError(`Senden fehlgeschlagen (${res.status}).`);
  return res.data;
}

export async function basketStatus(conn: PeerConn, basketId: string): Promise<StatusResponse> {
  const res = await httpGetJson<StatusResponse>(`${conn.url}/basket/${basketId}/status`, {
    'X-Session-Token': conn.token,
  });
  if (res.status !== 200) throw new PeerError(`Status nicht abrufbar (${res.status}).`);
  return res.data;
}
