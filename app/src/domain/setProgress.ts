/**
 * Set-Fortschritt (Sammlungs-Statistik): wie viele VERSCHIEDENE Karten eines Sets man
 * besitzt — egal in welcher Ausgabe (die meisten Bestände kennen ihre Ausgabe nicht,
 * PLAN.md § 3). Showcase-/Alt-Art-Drucke derselben Karte zählen einmal.
 * Framework-frei & rein testbar.
 */

export interface SetProgress {
  set: string;
  /** verschiedene Karten des Sets in der Sammlung */
  have: number;
  /** verschiedene Karten im Set */
  total: number;
  /** 0..1 */
  ratio: number;
}

/**
 * `owned`: oracleIds der Sammlung. `setCards`: Set-Code → oracleIds seiner Drucke.
 * Nur Sets mit mindestens einer eigenen Karte; sortiert nach Anzahl (meiste zuerst),
 * dann Vollständigkeit, dann Code.
 */
export function computeSetProgress(
  owned: ReadonlySet<string>,
  setCards: ReadonlyMap<string, ReadonlySet<string>>,
): SetProgress[] {
  const out: SetProgress[] = [];
  for (const [set, cards] of setCards) {
    if (cards.size === 0) continue;
    let have = 0;
    for (const id of cards) if (owned.has(id)) have++;
    if (have > 0) out.push({ set, have, total: cards.size, ratio: have / cards.size });
  }
  out.sort((a, b) => b.have - a.have || b.ratio - a.ratio || a.set.localeCompare(b.set));
  return out;
}
