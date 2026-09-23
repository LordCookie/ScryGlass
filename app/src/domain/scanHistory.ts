/**
 * Scan-Verlauf mit Rückgängig (Scanner). Framework-frei & rein testbar.
 *
 * Jede Übernahme in den Korb wird ein Eintrag (neueste zuerst, begrenzt). Der Status
 * folgt dem Weg der Karte: im Korb → in der Sammlung (nach „Übernehmen") bzw. an ein
 * Gerät gesendet. Rückgängig geht, solange die Karte im Korb oder in der eigenen
 * Sammlung liegt — an ein anderes Gerät Gesendetes lässt sich hier nicht zurückholen.
 */
import type { Card, Finish } from './types';

export type HistoryState = 'basket' | 'collection' | 'sent' | 'discarded' | 'undone';

export interface HistoryEntry {
  id: number;
  oracleId: string;
  card: Card;
  scryfallId?: string;
  finish: Finish;
  /** 'bild' | 'bild+ocr' | 'ocr' | 'manuell' … */
  method: string;
  /** automatisch übernommen (statt angetippt)? */
  auto: boolean;
  at: number;
  state: HistoryState;
  /** id im Scan-Protokoll — beim Rückgängig als Fehltreffer markieren. */
  logId?: number;
}

export const HISTORY_MAX = 12;

/** Neuen Eintrag vorne anfügen, auf `max` begrenzen. */
export function pushEntry(list: readonly HistoryEntry[], entry: HistoryEntry, max = HISTORY_MAX): HistoryEntry[] {
  return [entry, ...list].slice(0, max);
}

/** Alle Einträge im Status `from` auf `to` setzen (z. B. Korb übernommen). */
export function markAll(list: readonly HistoryEntry[], from: HistoryState, to: HistoryState): HistoryEntry[] {
  return list.map((e) => (e.state === from ? { ...e, state: to } : e));
}

/** Einen Eintrag ändern (Status, logId …). */
export function patchEntry(list: readonly HistoryEntry[], id: number, patch: Partial<HistoryEntry>): HistoryEntry[] {
  return list.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

/** Rückgängig möglich, solange die Karte im Korb oder in der eigenen Sammlung liegt. */
export function canUndo(e: HistoryEntry): boolean {
  return e.state === 'basket' || e.state === 'collection';
}

export const HISTORY_STATE_LABEL: Record<HistoryState, string> = {
  basket: 'im Korb',
  collection: 'in Sammlung',
  sent: 'gesendet',
  discarded: 'verworfen',
  undone: 'rückgängig',
};
