/**
 * Kartenbild-URLs (PLAN.md § 2, § 12). Werden zur LAUFZEIT aus der scryfallId
 * gebaut — nie gespeichert, nie verteilt. Der Service-Worker (vite.config.ts)
 * cached sie CacheFirst, sodass einmal gesehene Bilder offline verfügbar sind.
 */

import type { CardFace } from '../domain/cardFaces';

export type ImageSize = 'small' | 'normal' | 'large' | 'png' | 'art_crop';

/**
 * Im Big Screen kommen die Bilder vom Handy (`/img/…`, M20) — gleicher Pfad wie bei
 * Scryfall, das Handy hebt sie auf und holt fehlende selbst.
 */
let imageBase = 'https://cards.scryfall.io';
export function setCardImageBase(base: string | null): void {
  imageBase = base ?? 'https://cards.scryfall.io';
}

/** `face='back'` nur für doppelseitige Karten (domain/cardFaces.ts) — sonst 404. */
export function cardImageUrl(scryfallId: string, size: ImageSize = 'normal', face: CardFace = 'front'): string {
  const a = scryfallId[0];
  const b = scryfallId[1];
  const ext = size === 'png' ? 'png' : 'jpg';
  return `${imageBase}/${size}/${face}/${a}/${b}/${scryfallId}.${ext}`;
}
