import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from '../version';

/**
 * Kopfzeilen für die Scryfall-API (PLAN.md § 12). Scryfall lehnt allgemeine User-Agents
 * ab (Regel „generic_user_agent", z. B. „node") und bittet um einen eigenen. Am Handy
 * (CapacitorHttp) und im Big-Screen-Simulator (Node) setzen wir ihn; im Browser darf die
 * Seite ihn nicht ändern — dort schickt der Browser seinen eigenen, und den nimmt Scryfall.
 */
export function scryfallHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const own = typeof window === 'undefined' || Capacitor.isNativePlatform();
  return {
    Accept: 'application/json',
    ...(own ? { 'User-Agent': `ScryGlass/${APP_VERSION} (local-first MTG collection app)` } : {}),
    ...extra,
  };
}
