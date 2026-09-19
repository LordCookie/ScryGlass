/**
 * Countdown zum nächsten regulären MTG-Set (Header-Anzeige). Rein & framework-frei
 * (CLAUDE.md): Auswahl + Tage-Berechnung sind testbar; das Holen/Cachen liegt in
 * `data/nextSet.ts`.
 */

export interface UpcomingSet {
  code: string;
  name: string;
  releasedAt: string; // ISO-Datum „YYYY-MM-DD"
}

/** Nur die Felder der Scryfall-`/sets`-Antwort, die wir brauchen. */
export interface ScryfallSet {
  code: string;
  name: string;
  set_type?: string;
  released_at?: string;
  digital?: boolean;
}

// Reguläre Premier-Sets (Papier) — keine Tokens/Commander/Digital-Sets.
const PREMIER_TYPES = new Set(['expansion', 'core']);

/** Wählt das nächste reguläre Premier-Set (Papier) nach `now`, sonst null. */
export function pickNextSet(sets: readonly ScryfallSet[], now: Date): UpcomingSet | null {
  const nowMs = now.getTime();
  const next = sets
    .filter((s) => !s.digital && !!s.set_type && PREMIER_TYPES.has(s.set_type) && !!s.released_at)
    .filter((s) => Date.parse(`${s.released_at}T00:00:00Z`) > nowMs)
    .sort((a, b) => a.released_at!.localeCompare(b.released_at!))[0];
  return next ? { code: next.code, name: next.name, releasedAt: next.released_at! } : null;
}

/** Volle Tage von `now` bis zum Release (aufgerundet, nie negativ). */
export function daysUntil(releasedAt: string, now: Date): number {
  const ms = Date.parse(`${releasedAt}T00:00:00Z`) - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Header-Text „Next Set in N days" (englisch, bzw. Sonderfälle). */
export function nextSetLabel(set: UpcomingSet | null, now: Date): string | null {
  if (!set) return null;
  const days = daysUntil(set.releasedAt, now);
  if (days <= 0) return 'New set is out!';
  return `Next Set in ${days} ${days === 1 ? 'day' : 'days'}`;
}
