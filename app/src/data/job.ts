/**
 * Eine Aufgabe, die unabhängig vom Bildschirm weiterläuft (Katalog-/App-Update, M15).
 * Wechselt man den Tab, läuft sie weiter; die UI hängt sich nur an (`ui/useJob`). Ein
 * zweiter Start, solange sie läuft, schließt sich der laufenden an, statt sie zu
 * verdoppeln — früher startete ein erneuter Tipp nach dem Zurückkommen einen zweiten
 * Import, der mit dem ersten um die Datenbank stritt.
 */

export interface JobState<S, R> {
  running: boolean;
  /** aktueller Schritt (Fortschritt), nur während sie läuft */
  step: S | null;
  /** Ergebnis der letzten Runde */
  result: R | null;
  /** Fehler der letzten Runde */
  error: unknown;
}

export class Job<S, R> {
  private state: JobState<S, R> = { running: false, step: null, result: null, error: null };
  private listeners = new Set<() => void>();
  private current: Promise<void> | null = null;

  /** Für useSyncExternalStore: gleiche Referenz, solange sich nichts ändert. */
  get = (): JobState<S, R> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<JobState<S, R>>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Starten — oder der laufenden Runde anschließen. Wirft nie; Fehler stehen in `error`. */
  run(work: (onStep: (step: S) => void) => Promise<R>): Promise<void> {
    if (this.current) return this.current;
    this.set({ running: true, step: null, result: null, error: null });
    this.current = work((step) => this.set({ step }))
      .then(
        (result) => this.set({ running: false, step: null, result }),
        (error: unknown) => this.set({ running: false, step: null, error: error ?? new Error('Fehler') }),
      )
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  /** Ergebnis/Fehler der letzten Runde vergessen (z. B. „Nochmal versuchen"). */
  reset(): void {
    if (!this.state.running) this.set({ result: null, error: null });
  }
}
