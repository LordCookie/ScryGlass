import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * App-Update laden (M15) gegen ein nachgestelltes Android: `downloadFile` schreibt nur in
 * einen Ordner, den es schon gibt — `recursive` ignoriert @capacitor/filesystem 6.0.4
 * dort. Daran ist das Update in 0.2.6/0.2.7 jedes Mal gescheitert.
 */

const fs = vi.hoisted(() => {
  const dirs = new Set<string>();
  const files = new Map<string, number>(); // Pfad → Größe
  const parent = (p: string) => p.split('/').slice(0, -1).join('/');
  return {
    dirs,
    files,
    rmdir: vi.fn(async ({ path }: { path: string }) => {
      if (!dirs.delete(path)) throw new Error('Folder does not exist.');
      for (const f of [...files.keys()]) if (f.startsWith(`${path}/`)) files.delete(f);
    }),
    mkdir: vi.fn(async ({ path }: { path: string }) => {
      if (dirs.has(path)) throw new Error('Directory exists');
      dirs.add(path);
    }),
    downloadFile: vi.fn(async ({ path }: { path: string }) => {
      if (!dirs.has(parent(path))) {
        throw new Error(`Error downloading file: /data/user/0/x/cache/${path}: open failed: ENOENT (No such file or directory)`);
      }
      files.set(path, 40_000_000);
      return { path: `/data/user/0/x/cache/${path}` };
    }),
    stat: vi.fn(async ({ path }: { path: string }) => {
      const size = files.get(path);
      if (size == null) throw new Error('File does not exist');
      return { type: 'file', size, uri: `file:///data/user/0/x/cache/${path}` };
    }),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  };
});
const updater = vi.hoisted(() => ({
  canInstall: vi.fn(async () => ({ allowed: true, supported: true })),
  install: vi.fn(async (_opts: { path: string; sha256: string }) => {}),
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: fs,
  Directory: { Cache: 'CACHE', Data: 'DATA' },
}));
vi.mock('../native/appUpdater', () => ({
  AppUpdater: updater,
  hasAppUpdater: () => true,
  withScreenOn: <T,>(work: () => Promise<T>) => work(),
}));
const backups = vi.hoisted(() => ({
  autoBackup: vi.fn(async () => null),
  listAutoBackups: vi.fn(async (): Promise<{ name: string; at: number; reason: string }[]> => []),
}));
vi.mock('./backups', () => backups);

import { downloadAndInstall, UpdateError } from './updates';
import type { AppRelease } from '../domain/updates';

const SHA = 'ab'.repeat(32);
const rel: AppRelease = {
  version: '9.9.9',
  notes: 'Neu',
  apk: { name: 'ScryGlass-9.9.9.apk', url: 'https://x/ScryGlass-9.9.9.apk', size: 40_000_000 },
  sha256Url: 'https://x/ScryGlass-9.9.9.apk.sha256',
};

beforeEach(() => {
  fs.dirs.clear();
  fs.files.clear();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(`${SHA}  ScryGlass-9.9.9.apk\n`, { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App-Update laden (M15)', () => {
  it('legt den Ordner selbst an, lädt und übergibt die APK mit Prüfsumme dem Installer', async () => {
    await downloadAndInstall(rel, () => {});
    expect(fs.downloadFile).toHaveBeenCalledOnce();
    expect(updater.install).toHaveBeenCalledWith({
      path: '/data/user/0/x/cache/update/ScryGlass-9.9.9.apk',
      sha256: SHA,
    });
  });

  it('klappt auch, wenn vom letzten Versuch noch ein Ordner liegt', async () => {
    fs.dirs.add('update');
    await downloadAndInstall(rel, () => {});
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it('scheitert der Download, nennt die Meldung den nativen Grund', async () => {
    fs.downloadFile.mockRejectedValueOnce(new Error('Error downloading file: timeout'));
    const err = await downloadAndInstall(rel, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect((err as UpdateError).code).toBe('DOWNLOAD');
    expect((err as UpdateError).message).toBe('Download abgebrochen — Internet prüfen und nochmal. (timeout)');
    expect(updater.install).not.toHaveBeenCalled();
  });

  it('zweiter Versuch (Installer abgebrochen) nimmt die schon geladene APK statt neu zu laden', async () => {
    await downloadAndInstall(rel, () => {});
    await downloadAndInstall(rel, () => {});
    expect(fs.downloadFile).toHaveBeenCalledOnce();
    expect(updater.install).toHaveBeenLastCalledWith({
      path: 'file:///data/user/0/x/cache/update/ScryGlass-9.9.9.apk',
      sha256: SHA,
    });
  });

  it('passt die Prüfsumme der liegenden Datei nicht, wird neu geladen', async () => {
    fs.dirs.add('update');
    fs.files.set('update/ScryGlass-9.9.9.apk', 40_000_000);
    updater.install.mockRejectedValueOnce(Object.assign(new Error('Prüfsumme stimmt nicht'), { code: 'PRUEFSUMME' }));
    await downloadAndInstall(rel, () => {});
    expect(fs.downloadFile).toHaveBeenCalledOnce();
    expect(updater.install).toHaveBeenCalledTimes(2);
  });

  it('andere Fehler mit der liegenden Datei werden gemeldet, nicht überladen', async () => {
    fs.dirs.add('update');
    fs.files.set('update/ScryGlass-9.9.9.apk', 40_000_000);
    updater.install.mockRejectedValueOnce(Object.assign(new Error('Anders signiert'), { code: 'SIGNATUR' }));
    const err = await downloadAndInstall(rel, () => {}).catch((e: unknown) => e);
    expect((err as UpdateError).code).toBe('SIGNATUR');
    expect(fs.downloadFile).not.toHaveBeenCalled();
  });

  it('sichert beim zweiten Versuch innerhalb einer Stunde nicht nochmal', async () => {
    backups.listAutoBackups.mockResolvedValueOnce([{ name: 'a', at: Date.now() - 60_000, reason: 'vor-9.9.9' }]);
    await downloadAndInstall(rel, () => {});
    expect(backups.autoBackup).not.toHaveBeenCalled();
    backups.listAutoBackups.mockResolvedValueOnce([{ name: 'b', at: Date.now() - 2 * 3600_000, reason: 'vor-9.9.9' }]);
    await downloadAndInstall(rel, () => {});
    expect(backups.autoBackup).toHaveBeenCalledOnce();
  });
});
