import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db, setMeta } from '../db/db';
import { APP_VERSION } from '../version';
import { checkForUpdates, currentUpdateStatus, fetchLatestAppRelease, pendingWhatsNew, dismissWhatsNew } from './updates';
import type { GhRelease } from '../domain/updates';

/** Update-Prüfung gegen GitHub (gestubbt). Im Test läuft kein Capacitor → kein Katalog-Download. */

const [maj, min, pat] = APP_VERSION.split('.').map(Number);
const NEWER = `${maj}.${min}.${pat + 1}`;
const OLDER = `${maj}.${min}.${Math.max(0, pat - 1)}`;

const release = (v: string): GhRelease => ({
  tag_name: `v${v}`,
  draft: false,
  prerelease: false,
  body: `Neu in ${v}`,
  html_url: `https://github.com/LordCookie/ScryGlass/releases/tag/v${v}`,
  assets: [
    { name: `ScryGlass-${v}.apk`, size: 59_000_000, browser_download_url: `https://x/ScryGlass-${v}.apk` },
    { name: `ScryGlass-${v}.apk.sha256`, size: 90, browser_download_url: `https://x/ScryGlass-${v}.apk.sha256` },
  ],
});

function stubReleases(list: GhRelease[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(list), { status: 200 })));
}

beforeEach(async () => {
  await db.meta.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Update-Prüfung', () => {
  it('findet das neuere App-Release (Katalog-Releases stören nicht)', async () => {
    stubReleases([{ ...release('9.9.9'), tag_name: 'catalog-20261102', assets: [] }, release(NEWER)]);
    expect((await fetchLatestAppRelease())?.version).toBe(NEWER);
  });

  it('merkt neuere Version; nach dem Update (gleiche Version installiert) ist der Hinweis weg', async () => {
    stubReleases([release(NEWER)]);
    const s = await checkForUpdates(true);
    expect(s?.app?.version).toBe(NEWER);
    expect((await currentUpdateStatus())?.app?.version).toBe(NEWER);

    // gemerkter Stand nennt eine Version, die nicht neuer ist → kein Hinweis
    await setMeta('updateStatus', { checkedAt: Date.now(), app: { ...s!.app!, version: OLDER } });
    expect((await currentUpdateStatus())?.app).toBeUndefined();
  });

  it('höchstens einmal am Tag automatisch; ohne Netz bleibt der alte Stand', async () => {
    stubReleases([release(NEWER)]);
    await checkForUpdates();
    const fetchSpy = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchSpy);
    expect((await checkForUpdates())?.app?.version).toBe(NEWER); // heute schon geprüft
    expect(fetchSpy).not.toHaveBeenCalled();
    // erzwungen, aber offline: Fehler fürs UI, gemerkter Stand bleibt
    await expect(checkForUpdates(true)).rejects.toThrow(/nicht erreichbar/);
    expect((await currentUpdateStatus())?.app?.version).toBe(NEWER);
  });

  it('erfolgreiche Prüfung ohne Neues ersetzt einen alten Treffer', async () => {
    stubReleases([release(NEWER)]);
    await checkForUpdates(true);
    stubReleases([release(APP_VERSION)]); // NEWER zurückgezogen, nur die installierte da
    expect((await checkForUpdates(true))?.app).toBeUndefined();
  });

  it('„Was ist neu" nur, wenn genau diese Version jetzt läuft; danach weg', async () => {
    await setMeta('whatsNew', { version: NEWER, notes: 'x' });
    expect(await pendingWhatsNew()).toBeNull(); // noch nicht installiert
    await setMeta('whatsNew', { version: APP_VERSION, notes: 'Neu' });
    expect(await pendingWhatsNew()).toEqual({ version: APP_VERSION, notes: 'Neu' });
    await dismissWhatsNew();
    expect(await pendingWhatsNew()).toBeNull();
  });
});
