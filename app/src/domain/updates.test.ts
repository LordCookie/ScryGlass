import { describe, it, expect } from 'vitest';
import {
  parseVersion, compareVersions, isNewerVersion, pickLatestAppRelease, parseSha256, isNewerCatalog,
  updateCheckDue, UPDATE_CHECK_INTERVAL_MS, noteLines, catalogDate, formatMb, backupFileName, parseBackupFileName,
  documentsBackupName, backupReminderDue, BACKUP_REMIND_MS, BACKUP_REMIND_MIN_ROWS,
  type GhRelease,
} from './updates';

const rel = (tag: string, assets: string[], extra: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  body: `Notes ${tag}`,
  assets: assets.map((name) => ({ name, size: 100, browser_download_url: `https://x/${tag}/${name}` })),
  ...extra,
});

describe('Versionen', () => {
  it('liest „v0.2.5" und „0.2.5", sonst null', () => {
    expect(parseVersion('v0.2.5')).toEqual([0, 2, 5]);
    expect(parseVersion('0.10.0')).toEqual([0, 10, 0]);
    expect(parseVersion('catalog-20261102')).toBeNull();
    expect(parseVersion('0.2')).toBeNull();
  });

  it('vergleicht numerisch, nicht als Text', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.5', 'v0.2.5')).toBe(0);
    expect(isNewerVersion('0.2.6', '0.2.5')).toBe(true);
    expect(isNewerVersion('0.2.5', '0.2.5')).toBe(false);
    expect(isNewerVersion('kaputt', '0.2.5')).toBe(false);
  });
});

describe('pickLatestAppRelease', () => {
  it('nimmt das höchste vX.Y.Z mit APK — Katalog-Releases, Entwürfe und Releases ohne APK zählen nicht', () => {
    const r = pickLatestAppRelease([
      rel('catalog-20261102', ['cards.ndjson']),
      rel('v0.2.7', ['ScryGlass-0.2.7.apk'], { draft: true }),
      rel('v0.2.6', ['ScryGlass-0.2.6.apk', 'ScryGlass-0.2.6.apk.sha256'], { published_at: '2026-11-03T10:00:00Z' }),
      rel('v0.2.5', []),
      rel('v0.3.0-beta', ['ScryGlass-0.3.0-beta.apk']),
      rel('v0.2.10', ['andere.apk']),
    ]);
    expect(r).toEqual({
      version: '0.2.6',
      notes: 'Notes v0.2.6',
      publishedAt: '2026-11-03T10:00:00Z',
      pageUrl: undefined,
      apk: { name: 'ScryGlass-0.2.6.apk', url: 'https://x/v0.2.6/ScryGlass-0.2.6.apk', size: 100 },
      sha256Url: 'https://x/v0.2.6/ScryGlass-0.2.6.apk.sha256',
    });
  });

  it('nichts Passendes → null', () => {
    expect(pickLatestAppRelease([rel('catalog-latest', ['version.json'])])).toBeNull();
  });
});

describe('Prüfsumme, Katalog, Intervall', () => {
  it('sha256sum-Format', () => {
    const h = 'A'.repeat(64);
    expect(parseSha256(`${h}  ScryGlass-0.2.6.apk\n`)).toBe('a'.repeat(64));
    expect(parseSha256('nix')).toBeNull();
  });

  it('Katalog: Zeitstempel, neuer = größer; ohne lokalen Stand ist alles neuer', () => {
    expect(isNewerCatalog('20261102121500', '20261025210523')).toBe(true);
    expect(isNewerCatalog('20261025210523', '20261102121500')).toBe(false);
    expect(isNewerCatalog('20261025210523', '20261025210523')).toBe(false);
    expect(isNewerCatalog('20261025210523', undefined)).toBe(true);
    expect(isNewerCatalog(undefined, '20261025210523')).toBe(false);
  });

  it('höchstens einmal am Tag; eine verstellte Uhr (Zukunft) zählt als fällig', () => {
    const now = 1_000_000_000_000;
    expect(updateCheckDue(undefined, now)).toBe(true);
    expect(updateCheckDue(now - 1000, now)).toBe(false);
    expect(updateCheckDue(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(updateCheckDue(now + 5000, now)).toBe(true);
  });
});

describe('noteLines', () => {
  it('Überschriften, Aufzählungen, Absätze; Fettdruck-Sterne weg', () => {
    expect(noteLines('Das große Update.\n\n**Scanner**\n- Tokens mit **Artwork**\n* zweiter Punkt\n## Sammlung\n')).toEqual([
      { kind: 'text', text: 'Das große Update.' },
      { kind: 'heading', text: 'Scanner' },
      { kind: 'bullet', text: 'Tokens mit Artwork' },
      { kind: 'bullet', text: 'zweiter Punkt' },
      { kind: 'heading', text: 'Sammlung' },
    ]);
  });
});

describe('Anzeige und Sicherungs-Dateinamen', () => {
  it('Katalog-Datum und Megabyte', () => {
    expect(catalogDate('20261102121500')).toBe('02.11.2026');
    expect(catalogDate(undefined)).toBe('—');
    expect(formatMb(59_011_238)).toBe('59 MB');
    expect(formatMb(10)).toBe('1 MB');
  });

  it('Dateiname hin und zurück; Unsicheres wird ersetzt', () => {
    const n = backupFileName(1793000000000, 'vor 0.2.6/x');
    expect(n).toBe('auto-1793000000000-vor-0.2.6-x.json');
    expect(parseBackupFileName(n)).toEqual({ name: n, at: 1793000000000, reason: 'vor-0.2.6-x' });
    expect(parseBackupFileName('irgendwas.json')).toBeNull();
  });

  it('Sicherung für den Dokumente-Ordner: lesbarer Name in Ortszeit', () => {
    expect(documentsBackupName(new Date(2026, 10, 8, 9, 5).getTime())).toBe('scryglass-backup-2026-11-08-0905.json');
  });

  it('Erinnerung an die Sicherung: erst ab 30 Zeilen, nie gesichert oder älter als 30 Tage', () => {
    const now = 1_800_000_000_000;
    expect(backupReminderDue(undefined, BACKUP_REMIND_MIN_ROWS - 1, now)).toBe(false);
    expect(backupReminderDue(undefined, BACKUP_REMIND_MIN_ROWS, now)).toBe(true);
    expect(backupReminderDue(now - BACKUP_REMIND_MS + 1, 500, now)).toBe(false);
    expect(backupReminderDue(now - BACKUP_REMIND_MS - 1, 500, now)).toBe(true);
  });
});
