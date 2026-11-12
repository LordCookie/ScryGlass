import type { Deck, Owned, OwnedPrecon } from '../domain/types';

/**
 * Big Screen (PLAN.md M18): was Handy und Browser austauschen. Das Handy ist die einzige
 * Wahrheit; der Browser hält eine Kopie von Sammlung, Decks, Token-Zähler und Fertigdecks
 * und schickt Schreibaufträge ans Handy.
 */

export const BIGSCREEN_PORT = 8780;
/** Ausweich-Ports, falls 8780 belegt ist. */
export const BIGSCREEN_PORTS = [8780, 8781, 8782, 8783, 8784, 8785];

/** `GET /bigscreen.json` — daran erkennt die Web-App den Fernbetrieb. */
export interface BigScreenInfo {
  mode: 'bigscreen';
  deviceName: string;
  appVersion: string;
  /** Katalog-Dateien unter `/catalog/`: gepackt (.gz, vom Katalog-Update aufgehoben) oder roh (aus der APK) */
  catalogGzip?: boolean;
}

/** Wo der Browser den Katalog des Handys findet. */
export const REMOTE_CATALOG_BASE = '/catalog';
/** Kartenbilder vom Handy (M20): `/img/<größe>/<seite>/<a>/<b>/<id>.jpg`. */
export const REMOTE_IMAGE_BASE = '/img';

export interface Snapshot {
  seq: number;
  owned: Owned[];
  decks: Deck[];
  ownedPrecons: OwnedPrecon[];
  tokenCount: number;
}

export type ReplicaTable = 'owned' | 'decks' | 'ownedPrecons';

/** Neuer Scan am Handy — für die Anzeige unten rechts (DESIGN A11). */
export interface ScanNotice {
  id: number;
  at: number;
  oracleId: string;
  name: string;
  via: string;
}

export interface PhoneStatus {
  device: string;
  /** Farbschema des Handys — der Browser übernimmt es */
  theme?: string;
  battery?: { level: number; charging: boolean };
  idleMs: number;
}

/** Nachrichten vom Handy über den WebSocket `/api/events`. */
export type ServerMsg =
  | { t: 'hello'; seq: number; session: string; status: PhoneStatus }
  | { t: 'change'; seq: number; table: ReplicaTable; puts: unknown[]; deletes: (number | string)[] }
  | { t: 'tokens'; seq: number; count: number }
  /** Zu viel auf einmal geändert (Import, Wiederherstellen) — neu holen. */
  | { t: 'reset'; seq: number }
  | { t: 'scan'; scan: ScanNotice }
  | { t: 'scanRejected'; id: number }
  | { t: 'status'; status: PhoneStatus }
  /** Anmeldung abgelaufen (keine Eingabe) — Kopie bleibt, Anmeldeseite drüber. */
  | { t: 'expired' }
  /** Abgemeldet oder Big Screen aus. */
  | { t: 'bye'; reason: 'abgemeldet' | 'aus' };

/** Nachrichten mit fortlaufender Nummer (Änderungen an der Kopie). */
export type SeqMsg = Extract<ServerMsg, { t: 'change' } | { t: 'tokens' } | { t: 'reset' }>;

export interface WriteRequest {
  op: string;
  args: unknown[];
}

export type WriteResponse = { ok: true; result: unknown; seq: number } | { ok: false; error: string };

export interface ChallengeResponse {
  salt: string;
  iterations: number;
  nonce: string;
}

/** Eine Anfrage, wie sie der native Server an JS weiterreicht. */
export interface HostRequest {
  id: string;
  method: string;
  path: string;
  cookie?: string;
  body?: string;
  remote?: string;
  userAgent?: string;
}

export interface HostResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
