import { useEffect, useRef } from 'react';

/**
 * Android-Zurück-Taste: ein Stapel offener Ebenen (Scanner-Overlay, Kartendetail,
 * Deck-Editor, Tab ≠ Sammlung). Zurück schließt die zuletzt geöffnete Ebene; ist
 * keine offen, entscheidet der Aufrufer (App minimieren). Reihenfolge = Reihenfolge
 * des Öffnens — so wie die Ebenen auch übereinander liegen.
 */

type Handler = () => void;

const stack: { id: number; fn: Handler }[] = [];
let nextId = 1;

/** Ebene anmelden; liefert die Abmeldung. */
export function pushBack(fn: Handler): () => void {
  const id = nextId++;
  stack.push({ id, fn });
  return () => {
    const i = stack.findIndex((e) => e.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Zurück gedrückt: oberste Ebene schließen. `false` = nichts offen. */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}

/** Nur für Tests. */
export function backDepth(): number {
  return stack.length;
}

/**
 * Solange `active`, schließt Zurück diese Ebene über `onBack`. Neu angemeldet wird nur
 * beim Wechsel von `active` — ein neues `onBack` je Render ändert die Reihenfolge nicht.
 */
export function useBackHandler(active: boolean, onBack: Handler): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    return pushBack(() => ref.current());
  }, [active]);
}
