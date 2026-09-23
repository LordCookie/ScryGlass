import { getMeta, setMeta } from '../db/db';

/**
 * Farbschemata (Mehr → Einstellungen). Die Farben selbst stehen als Token-Sätze in
 * index.css (`:root[data-theme=…]`); hier nur Auswahl, Anwenden und Merken (Dexie).
 */

export type ThemeKey = 'violett' | 'abendrot' | 'gold';

export interface ThemeInfo {
  key: ThemeKey;
  name: string;
  /** Vorschau-Farben: Hintergrund, Rahmen, Akzent, Hell */
  swatches: string[];
  /** Hintergrund für <meta name="theme-color"> */
  bg: string;
}

export const THEMES: readonly ThemeInfo[] = [
  { key: 'violett', name: 'Violett', swatches: ['#250E47', '#792DEB', '#D0B0FF', '#F2E9FF'], bg: '#250E47' },
  { key: 'abendrot', name: 'Abendrot', swatches: ['#2A0F22', '#B55690', '#EF7627', '#FFFFFF'], bg: '#2A0F22' },
  { key: 'gold', name: 'Schwarz-Gold', swatches: ['#0A0A0A', '#8C6D1A', '#D4AF37', '#FFFFFF'], bg: '#0A0A0A' },
];

const THEME_KEY = 'theme';

function isTheme(v: unknown): v is ThemeKey {
  return THEMES.some((t) => t.key === v);
}

/** Schema auf die Seite anwenden (Violett = Standard ohne Attribut). */
export function applyTheme(key: ThemeKey): void {
  const root = document.documentElement;
  if (key === 'violett') delete root.dataset.theme;
  else root.dataset.theme = key;
  const info = THEMES.find((t) => t.key === key);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info?.bg ?? '#250E47');
}

export function currentTheme(): ThemeKey {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : 'violett';
}

let userChose = false;

/** Gespeichertes Schema laden und anwenden (beim Start, vor dem ersten Bild).
 *  Kam die Nutzerwahl schneller, gewinnt sie. */
export async function restoreTheme(): Promise<void> {
  const v = await getMeta<string>(THEME_KEY);
  if (!userChose && isTheme(v)) applyTheme(v);
}

/** Schema wählen: sofort anwenden und merken. */
export function chooseTheme(key: ThemeKey): void {
  userChose = true;
  applyTheme(key);
  void setMeta(THEME_KEY, key);
}
