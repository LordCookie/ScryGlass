import { getMeta, setMeta } from '../db/db';

/**
 * Scanner-Diagnose (PLAN.md § 6.2, Schritt 1): zeigt im Scanner live den tatsächlich
 * ausgewerteten Ausschnitt und speichert ihn im Scan-Protokoll mit. Geschaltet unter
 * Mehr → Scanner-Protokoll; standardmäßig aus.
 */
const KEY = 'scanDiag';

export async function getScanDiag(): Promise<boolean> {
  return (await getMeta<boolean>(KEY)) === true;
}

export function setScanDiag(on: boolean): Promise<void> {
  return setMeta(KEY, on);
}
