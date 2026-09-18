/**
 * Kartenbild-URLs (PLAN.md § 2, § 12). Werden zur LAUFZEIT aus der scryfallId
 * gebaut — nie gespeichert, nie verteilt. Der Service-Worker (vite.config.ts)
 * cached sie CacheFirst, sodass einmal gesehene Bilder offline verfügbar sind.
 */

export type ImageSize = 'small' | 'normal' | 'large' | 'png' | 'art_crop';

export function cardImageUrl(scryfallId: string, size: ImageSize = 'normal'): string {
  const a = scryfallId[0];
  const b = scryfallId[1];
  const ext = size === 'png' ? 'png' : 'jpg';
  return `https://cards.scryfall.io/${size}/front/${a}/${b}/${scryfallId}.${ext}`;
}
