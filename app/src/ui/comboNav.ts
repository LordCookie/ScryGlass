/**
 * Sprung zu den Kombos in der Suche (z. B. aus der Σ-Statistik). Die Tabs werden nur
 * gerendert, wenn sie aktiv sind — also merken wir den Wunsch, bis die Suche ihn abholt.
 */
export const OPEN_COMBOS_EVENT = 'scryglass:open-combos';

let pending = false;

export function openCombos(): void {
  pending = true;
  window.dispatchEvent(new Event(OPEN_COMBOS_EVENT));
}

/** Von der Suche beim Öffnen gefragt: soll sie mit „Kombos" starten? Ohne Nebenwirkung —
 *  React ruft State-Initialisierer im StrictMode doppelt auf. */
export function comboRequested(): boolean {
  return pending;
}

/** Nach dem Öffnen abhaken (im Effect, einmal). */
export function clearComboRequest(): void {
  pending = false;
}
