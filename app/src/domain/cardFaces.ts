/**
 * Doppelseitige Karten (Transform, Modal-DFC, Reversible): haben ein echtes zweites
 * Kartenbild auf dem Scryfall-CDN (`…/back/…`). Split-, Adventure- oder Flip-Karten
 * sind dagegen EIN Bild; Meld-Rückseiten sind eigene Karten. Rein & testbar.
 */
export type CardFace = 'front' | 'back';

export const DFC_LAYOUTS: ReadonlySet<string> = new Set(['transform', 'modal_dfc', 'reversible_card']);

export function isDoubleFaced(layout: string | undefined): boolean {
  return !!layout && DFC_LAYOUTS.has(layout);
}
