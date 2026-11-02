/**
 * Updates aus der App (PLAN.md M15): App-Version und Katalog über die öffentlichen
 * GitHub-Releases. Framework-frei & rein testbar — Netz und Gerät hängen in
 * `data/updates.ts` bzw. im nativen Plugin `AppUpdater`.
 *
 * Wichtig: Nicht `releases/latest` nehmen — die wöchentlichen Katalog-Releases
 * („catalog-20261102") gelten bei GitHub sonst als „neuestes Release". Die App sucht
 * selbst das höchste `vX.Y.Z` mit APK.
 */

/** Ausschnitt eines Releases aus der GitHub-API (`/repos/…/releases`). */
export interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
export interface GhRelease {
  tag_name: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  html_url?: string;
  assets: GhAsset[];
}

export interface AppRelease {
  version: string;
  /** Patch Notes (Markdown aus dem Release) */
  notes: string;
  publishedAt?: string;
  pageUrl?: string;
  apk: { name: string; url: string; size: number };
  /** `<apk>.sha256` im selben Release — Prüfsumme der APK */
  sha256Url?: string;
}

/** „v0.2.5" / „0.2.5" → [0, 2, 5]; alles andere → null. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0 wie bei sort; ungültige Versionen gelten als ältestes. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function isNewerVersion(remote: string, current: string): boolean {
  return compareVersions(remote, current) > 0;
}

/** Höchstes App-Release (`vX.Y.Z`, kein Entwurf/Vorab) mit APK `ScryGlass-X.Y.Z.apk`. */
export function pickLatestAppRelease(releases: readonly GhRelease[]): AppRelease | null {
  let best: AppRelease | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !parseVersion(r.tag_name)) continue;
    const version = r.tag_name.replace(/^v/, '');
    const apk = r.assets.find((a) => a.name === `ScryGlass-${version}.apk`);
    if (!apk) continue;
    if (best && !isNewerVersion(version, best.version)) continue;
    const sha = r.assets.find((a) => a.name === `${apk.name}.sha256`);
    best = {
      version,
      notes: (r.body ?? '').trim(),
      publishedAt: r.published_at ?? undefined,
      pageUrl: r.html_url,
      apk: { name: apk.name, url: apk.browser_download_url, size: apk.size },
      sha256Url: sha?.browser_download_url,
    };
  }
  return best;
}

/** Inhalt einer `.sha256`-Datei (Format von sha256sum) → 64 Hex-Zeichen, klein. */
export function parseSha256(text: string): string | null {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Katalog-Versionen sind Zeitstempel „YYYYMMDDhhmmss" — neuer = größer. */
export function isNewerCatalog(remote: string | undefined, local: string | undefined): boolean {
  if (!remote) return false;
  if (!local) return true;
  return remote > local;
}

/** Automatisch höchstens einmal am Tag nachsehen. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function updateCheckDue(lastAt: number | undefined, now: number): boolean {
  return lastAt == null || now - lastAt >= UPDATE_CHECK_INTERVAL_MS || now < lastAt;
}

/**
 * Patch Notes (Markdown aus dem Release) als schlichte Zeilen für die Anzeige:
 * „**Titel**" → Überschrift, „- Punkt" → Aufzählung, sonst Absatz; leere Zeilen fallen weg.
 */
export type NoteLine = { kind: 'heading' | 'bullet' | 'text'; text: string };

export function noteLines(md: string): NoteLine[] {
  const out: NoteLine[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(?:#{1,6}\s+(.+)|\*\*(.+)\*\*)$/.exec(line);
    if (heading) {
      out.push({ kind: 'heading', text: (heading[1] ?? heading[2]).replace(/\*\*/g, '') });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) out.push({ kind: 'bullet', text: bullet[1].replace(/\*\*/g, '') });
    else out.push({ kind: 'text', text: line.replace(/\*\*/g, '') });
  }
  return out;
}

// --- Anzeige & automatische Sicherungen --------------------------------------

/** Katalog-Version „20261102121500" → „02.11.2026"; Unbekanntes bleibt, wie es ist. */
export function catalogDate(v: string | undefined): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (v ?? '—');
}

/** Bytes → „59 MB" (gerundet, mindestens 1). */
export function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** Dateiname einer automatischen Sicherung, z. B. „auto-1793000000000-vor-0.2.6.json". */
export function backupFileName(at: number, reason: string): string {
  return `auto-${at}-${reason.replace(/[^a-z0-9.-]+/gi, '-')}.json`;
}

export function parseBackupFileName(name: string): { name: string; at: number; reason: string } | null {
  const m = /^auto-(\d+)-(.+)\.json$/.exec(name);
  return m ? { name, at: Number(m[1]), reason: m[2] } : null;
}
