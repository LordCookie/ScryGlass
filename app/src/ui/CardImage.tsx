import { useState } from 'react';
import { cardImageUrl, type ImageSize } from '../data/cardImages';
import type { CardFace } from '../domain/cardFaces';

/**
 * Kartenbild vom Scryfall-CDN (PLAN.md § 12: nur verlinkt, lokal via SW gecacht).
 * `scryfallId` fehlt → neutraler Platzhalter (kein Netzwerk-Fehlerbild).
 */
export function CardImage({
  scryfallId,
  name,
  size = 'small',
  className = 'h-16 w-11',
  face = 'front',
}: {
  scryfallId?: string;
  name?: string;
  size?: ImageSize;
  className?: string;
  /** Rückseite doppelseitiger Karten. */
  face?: CardFace;
}) {
  const [failed, setFailed] = useState(false);
  if (!scryfallId || failed) {
    return (
      <div
        className={`flex items-center justify-center overflow-hidden rounded bg-bg text-[8px] text-muted ${className}`}
        title={name}
      >
        {name ? name.slice(0, 12) : '—'}
      </div>
    );
  }
  return (
    <img
      src={cardImageUrl(scryfallId, size, face)}
      alt={name ?? 'Karte'}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`rounded object-cover ${className}`}
    />
  );
}
