/**
 * Peer-Scanning-Protokoll (PLAN.md § 8). Gemeinsame Typen + QR-Pairing-Schema
 * zwischen Sender (TS) und Empfänger (Kotlin-Server). Framework-frei & testbar.
 */
import type { BasketEntry } from '../domain/types';
import { PROTOCOL_VERSION } from '../version';

export const PEER_DEFAULT_PORT = 8765;
export const PEER_PORT_FALLBACKS = [8765, 8766, 8767];
export const PAIRING_SCHEME = 'mtgscan';

/** GET /hello — Handshake. */
export interface HelloResponse {
  deviceName: string;
  catalogVersion: string;
  protocolVersion: number;
  cardCount: number;
}

/** POST /basket — Body. */
export interface BasketPayload {
  basketId: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  entries: BasketEntry[];
}

/** POST /basket — Antwort. */
export interface BasketAck {
  accepted: number;
  basketId: string;
}

/** GET /basket/:id/status — Antwort. */
export interface StatusResponse {
  status: 'received' | 'reviewed' | 'accepted';
  accepted: number;
  rejected: number;
}

export interface PairingInfo {
  host: string;
  port: number;
  token: string;
  name: string;
}

/** 6-stelliger Session-Token (kein Krypto — nur gegen versehentliches Fremd-Pushen, § 8). */
export function generateToken(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function buildPairingUrl(info: PairingInfo): string {
  const q = `t=${encodeURIComponent(info.token)}&n=${encodeURIComponent(info.name)}`;
  return `${PAIRING_SCHEME}://${info.host}:${info.port}?${q}`;
}

/** Parst einen gescannten QR-Code. `null`, wenn es kein Pairing-Code ist. */
export function parsePairingUrl(raw: string): PairingInfo | null {
  const s = raw.trim();
  const m = /^mtgscan:\/\/([^:/?#]+):(\d+)\?(.*)$/i.exec(s);
  if (!m) return null;
  const host = m[1];
  const port = parseInt(m[2], 10);
  if (!Number.isFinite(port)) return null;
  const params = new URLSearchParams(m[3]);
  const token = params.get('t');
  if (!token) return null;
  const name = params.get('n') ?? 'Gerät';
  return { host, port, token, name };
}

export function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function isProtocolCompatible(hello: HelloResponse): boolean {
  return hello.protocolVersion === PROTOCOL_VERSION;
}
