import { useCallback, useEffect, useRef, useState } from 'react';
import App from '../../App';
import { applyUpdate, fetchRemoteVersion, getLocalCatalogVersion, type CatalogVersion } from '../../data/catalog';
import { db } from '../../db/db';
import { invalidateNameIndex } from '../../data/matcher';
import { invalidateSearchIndex } from '../../data/search';
import { syncCombos } from '../../data/combos';
import { syncPrecons } from '../../data/precons';
import type { RemoteClient } from '../../bigscreen/client';
import { REMOTE_CATALOG_BASE, type CatalogSubset } from '../../bigscreen/protocol';
import { startImagePrefetch } from '../../bigscreen/prefetch';
import { storageCheck, isStorageBlockedError, type StorageState } from '../../bigscreen/storageCheck';
import { BigScreenLoader, type LoadStep } from './BigScreenLoader';
import { RemoteLogin } from './RemoteLogin';
import { ScanToasts } from './ScanToasts';
import { useRemoteState } from './ConnectionIndicator';

/**
 * Big Screen im Browser (PLAN.md M18): Anmelden → Katalog vom Handy (nur wenn der Stand
 * neu ist) → Sammlung & Decks → die App. Läuft die Anmeldung ab, legt sich die Anmeldeseite
 * über die App; nach dem Anmelden geht es an derselben Stelle weiter.
 *
 * Schneller Start (M20, Vorschlag des Nutzers): Ist der Katalogstand neu, holt der Browser
 * erst nur die Katalogdaten der eigenen Karten (ein Rutsch, Sekunden) — dann geht die App
 * auf, und der ganze Katalog, Kombos und Fertigdecks laden im Hintergrund. Erst danach gilt
 * der Stand als eingespielt; bricht man ab, geht es nächstes Mal dort weiter.
 */

/** Fortschritt des Hintergrund-Ladens (nur während der große Katalog läuft). */
type Background = { done: number; total: number } | null;
export function RemoteRoot({ client }: { client: RemoteClient }) {
  const st = useRemoteState(client);
  const [step, setStep] = useState<LoadStep>({ phase: 'karten', done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [background, setBackground] = useState<Background>(null);
  // Darf der Browser hier speichern? Sonst gleich erklären statt später scheitern (M20).
  const [storage, setStorage] = useState<{ state: StorageState; detail?: string } | null>(null);
  const running = useRef(false);

  useEffect(() => {
    void client.check();
    void storageCheck().then(setStorage);
  }, [client]);

  const load = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    const gzip = !!st.info.catalogGzip;
    try {
      const base = REMOTE_CATALOG_BASE;
      const [local, remote] = await Promise.all([getLocalCatalogVersion(), fetchRemoteVersion(base, 15_000)]);
      if (!remote) throw new Error('Der Katalog des Handys ist nicht erreichbar.');
      // Genau den Stand des Handys — auch wenn hier ein anderer liegt. Erst die eigenen Karten.
      const later = local !== remote.catalogVersion;
      if (later) {
        setStep({ phase: 'karten', done: 0, total: 0 });
        const r = await fetch('/api/catalog-subset', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Deine Karten kamen nicht vom Handy.');
        const sub = (await r.json()) as CatalogSubset;
        await db.transaction('rw', db.cards, db.printings, db.names, async () => {
          await db.cards.bulkPut(sub.cards);
          await db.printings.bulkPut(sub.printings);
          await db.names.bulkPut(sub.names);
        });
        const n = sub.cards.length + sub.printings.length + sub.names.length;
        setStep({ phase: 'karten', done: n, total: n });
        invalidateNameIndex();
        invalidateSearchIndex();
      }
      setStep({ phase: 'sammlung' });
      await client.connect();
      setStep({ phase: 'fertig' });
      startImagePrefetch();
      void loadRest(remote, base, gzip, later, setBackground);
    } catch (e) {
      if (isStorageBlockedError(e)) setStorage({ state: 'blockiert', detail: (e as Error).message });
      else setError((e as Error).message || 'Laden fehlgeschlagen.');
    } finally {
      running.current = false;
    }
  }, [client, st.info.catalogGzip]);

  useEffect(() => {
    if (st.phase === 'laden') void load();
  }, [st.phase, load]);

  if (storage && storage.state !== 'ok') {
    return <StorageHelp state={storage.state} detail={storage.detail} />;
  }
  if (st.phase === 'pruefen') {
    return <Centered title="Verbinde mit dem Handy…" />;
  }
  if (st.phase === 'anmelden') {
    return <RemoteLogin client={client} device={st.info.deviceName} />;
  }
  if (st.phase === 'aus') {
    return (
      <Centered title="Big Screen ist aus" subtitle="Am Handy unter Mehr → Big Screen wieder einschalten, dann hier neu laden.">
        <button onClick={() => location.reload()} className="pxbtn pxbtn-primary mt-6 font-hud text-[10px]">Neu laden</button>
      </Centered>
    );
  }
  if (st.phase === 'laden') {
    return <BigScreenLoader step={step} device={st.info.deviceName} error={error} onRetry={() => void load()} />;
  }
  return (
    <>
      <App remote />
      {background && <BackgroundStrip {...background} />}
      <ScanToasts />
      {st.phase === 'abgelaufen' && <RemoteLogin client={client} device={st.info.deviceName} overlay />}
    </>
  );
}

/**
 * Im Hintergrund: der ganze Katalog (falls der Stand neu ist), dann Kombos und Fertigdecks
 * (die kümmern sich selbst darum, ob sie neu sind). Fehler sind still — beim nächsten
 * Laden geht es weiter, weil der Stand erst am Ende als eingespielt gilt.
 */
async function loadRest(remote: CatalogVersion, base: string, gzip: boolean, catalog: boolean, set: (b: Background) => void) {
  const c = remote.counts;
  const catalogTotal = catalog ? c.cards + c.printings + c.names : 0;
  const total = catalogTotal + (c.combos ?? 0) + (c.precons ?? 0);
  const show = (done: number) => { if (catalog) set({ done, total }); };
  try {
    if (catalog) {
      show(0);
      await applyUpdate(remote, { base, gzip, onProgress: (p) => show(p.overallDone) });
      invalidateNameIndex();
      invalidateSearchIndex();
    }
    let comboDone = 0;
    await syncCombos(base, remote.catalogVersion, (done) => { comboDone = done; show(catalogTotal + done); }, gzip);
    await syncPrecons(base, remote.catalogVersion, (done) => show(catalogTotal + comboDone + done), gzip);
  } catch {
    /* nächstes Mal weiter */
  } finally {
    set(null);
  }
}

/** Kleiner Hinweis unten links, solange der übrige Katalog im Hintergrund lädt. */
function BackgroundStrip({ done, total }: { done: number; total: number }) {
  const pct = Math.min(100, Math.round((done / Math.max(1, total)) * 100));
  return (
    <div className="pointer-events-none fixed bottom-20 left-3 z-20 w-64 border-2 border-fill bg-surface p-2 font-mono text-[11px] text-muted lg:bottom-4 lg:left-52">
      <p>Lade den übrigen Katalog · {pct} %</p>
      <div className="mt-1 h-1.5 w-full bg-bg"><div className="h-full bg-fill" style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-[10px]">Deine Karten sind schon da. Suche und weitere Ausgaben werden gleich vollständig.</p>
    </div>
  );
}

/** Browser lässt nichts speichern (oder der Speicher ist kaputt): was zu tun ist. */
function StorageHelp({ state, detail }: { state: StorageState; detail?: string }) {
  const host = location.host;
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-10">
      <h1 className="font-hud text-xl">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
      </h1>
      <div className="frame mt-8 w-full max-w-xl bg-surface p-5 font-mono text-sm">
        {state === 'blockiert' ? (
          <>
            <p className="text-lg text-text">Dieser Browser lässt die Seite nichts speichern</p>
            <p className="mt-2 text-muted">
              Big Screen braucht im Browser ein Cookie für die Anmeldung und Speicher für den Katalog. Für {host} sind
              „Cookies und Website-Daten" gerade blockiert.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-text">
              <li>Links neben der Adresse auf das Symbol klicken → „Website-Einstellungen".</li>
              <li>„Cookies und Website-Daten" (Chrome: „Auf dem Gerät gespeicherte Daten") auf „Zulassen" stellen.</li>
              <li>Kein privates Fenster und keine Erweiterung, die Speicher sperrt. Dann neu laden.</li>
            </ol>
          </>
        ) : (
          <>
            <p className="text-lg text-text">Der Speicher dieser Seite im Browser ist beschädigt</p>
            <p className="mt-2 text-muted">
              Links neben der Adresse auf das Symbol klicken → „Website-Einstellungen" → „Daten löschen", dann neu laden.
              Deine Sammlung liegt auf dem Handy und bleibt, wie sie ist.
            </p>
          </>
        )}
        {detail && <p className="mt-3 text-[10px] text-muted">Meldung des Browsers: {detail}</p>}
        <button onClick={() => location.reload()} className="pxbtn pxbtn-primary mt-4 font-hud text-[10px]">Neu laden</button>
      </div>
    </div>
  );
}

function Centered({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 text-center">
      <h1 className="font-hud text-xl">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
      </h1>
      <p className="mt-6 font-mono text-lg text-text">{title}</p>
      {subtitle && <p className="mt-1 max-w-md font-mono text-sm text-muted">{subtitle}</p>}
      {children}
    </div>
  );
}
