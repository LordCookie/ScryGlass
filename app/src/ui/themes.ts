import { getMeta, setMeta, writeGateway } from '../db/db';

/**
 * Farbschemata (Mehr → Einstellungen). Die Farben selbst stehen als Token-Sätze in
 * index.css (`:root[data-theme=…]`); hier nur Auswahl, Anwenden und Merken (Dexie).
 */

export type ThemeKey = 'violett' | 'abendrot' | 'gold' | 'halloween' | 'gameboy' | 'tiefsee';

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
  // Saison-Schema: Kürbis-Orange auf Schwarz, Hexen-Lila in den Titelbalken.
  { key: 'halloween', name: 'Halloween', swatches: ['#0D0A0B', '#4B1D5C', '#FF7518', '#FFE8CC'], bg: '#0D0A0B' },
  // M23: das Grün des ersten Game Boy (vier Stufen) und ein tiefes Nachtblau mit Cyan.
  { key: 'gameboy', name: 'Game Boy', swatches: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'], bg: '#0F380F' },
  { key: 'tiefsee', name: 'Tiefsee', swatches: ['#0A1628', '#246C9E', '#3FD0E0', '#CFE8F7'], bg: '#0A1628' },
];

const THEME_KEY = 'theme';

function isTheme(v: unknown): v is ThemeKey {
  return THEMES.some((t) => t.key === v);
}

/** Schema auf die Seite anwenden (Violett = Standard ohne Attribut). */
export function applyTheme(key: ThemeKey): void {
  if (typeof document === 'undefined') return; // Big-Screen-Simulator (Node)
  const root = document.documentElement;
  if (key === 'violett') delete root.dataset.theme;
  else root.dataset.theme = key;
  const info = THEMES.find((t) => t.key === key);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info?.bg ?? '#250E47');
}

export function currentTheme(): ThemeKey {
  if (typeof document === 'undefined') return 'violett';
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

/** Schema wählen: sofort anwenden und merken. Im Big Screen (M18) gilt es fürs Handy —
 *  das Handy übernimmt es und meldet es an alle Browser zurück. */
export function chooseTheme(key: ThemeKey): void {
  userChose = true;
  applyTheme(key);
  const gw = writeGateway();
  if (gw) void gw('setTheme', [key]).catch(() => {});
  else void setMeta(THEME_KEY, key);
}

/** Big Screen im Browser: das Schema des Handys übernehmen (und für den nächsten Start merken). */
export function followTheme(key: string | undefined): void {
  if (!isTheme(key) || key === currentTheme()) return;
  applyTheme(key);
  void setMeta(THEME_KEY, key);
}

export function isThemeKey(v: unknown): v is ThemeKey {
  return isTheme(v);
}
