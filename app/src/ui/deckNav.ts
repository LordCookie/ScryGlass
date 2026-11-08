/**
 * Sprung zu einem Deck (z. B. nach „Fertigdeck hinzufügen"). Wie bei den Kombos: Die Tabs
 * werden nur gerendert, wenn sie aktiv sind — der Wunsch wartet, bis die Decks ihn abholen.
 */
export const OPEN_DECK_EVENT = 'scryglass:open-deck';

let pending: number | null = null;

export function openDeck(id: number): void {
  pending = id;
  window.dispatchEvent(new Event(OPEN_DECK_EVENT));
}

/** Ohne Nebenwirkung — React ruft State-Initialisierer im StrictMode doppelt auf. */
export function deckRequested(): number | null {
  return pending;
}

export function clearDeckRequest(): void {
  pending = null;
}
