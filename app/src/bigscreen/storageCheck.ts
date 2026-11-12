/**
 * Darf diese Seite im Browser speichern? (Big Screen, M20) Big Screen braucht ein Cookie
 * (Anmeldung) und IndexedDB (Katalog, Kopie der Sammlung). Sind „Cookies und
 * Website-Daten" für die Adresse blockiert — Browser-Einstellung, Erweiterung,
 * Firmenrichtlinie —, scheitert sonst erst der Ladebildschirm mit einer englischen
 * Browser-Meldung. Hier vorher prüfen und verständlich erklären.
 */

export type StorageState = 'ok' | 'blockiert' | 'kaputt';

const PROBE = 'scryglass-speichertest';

export function storageCheck(timeoutMs = 5000): Promise<{ state: StorageState; detail?: string }> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || !navigator.cookieEnabled) {
      resolve({ state: 'blockiert' });
      return;
    }
    const timer = setTimeout(() => resolve({ state: 'ok' }), timeoutMs); // hängt es, nicht blockieren
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(PROBE);
    } catch (e) {
      clearTimeout(timer);
      resolve({ state: 'blockiert', detail: (e as Error).message });
      return;
    }
    req.onsuccess = () => {
      clearTimeout(timer);
      req.result.close();
      try {
        indexedDB.deleteDatabase(PROBE);
      } catch {
        /* egal */
      }
      resolve({ state: 'ok' });
    };
    req.onerror = () => {
      clearTimeout(timer);
      const err = req.error;
      resolve({ state: storageErrorKind(err), detail: err ? `${err.name}: ${err.message}` : undefined });
    };
  });
}

/** Browser-Fehler beim Speichern einordnen: gesperrt oder beschädigt? */
export function storageErrorKind(err: { name?: string; message?: string } | null | undefined): StorageState {
  const msg = `${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
  if (/denied|permission|securityerror|not allowed|insecure/.test(msg)) return 'blockiert';
  return 'kaputt';
}

/** Gehört ein Fehler aus dem Laden zu einem gesperrten Speicher? */
export function isStorageBlockedError(e: unknown): boolean {
  const err = e as { name?: string; message?: string; inner?: { name?: string; message?: string } } | null;
  return storageErrorKind(err) === 'blockiert' || storageErrorKind(err?.inner) === 'blockiert';
}
