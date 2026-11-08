import { useCallback, useEffect, useRef, useState } from 'react';
import App from '../../App';
import { applyUpdate, fetchRemoteVersion, getLocalCatalogVersion } from '../../data/catalog';
import { invalidateNameIndex } from '../../data/matcher';
import { invalidateSearchIndex } from '../../data/search';
import { syncCombos } from '../../data/combos';
import { syncPrecons } from '../../data/precons';
import type { RemoteClient } from '../../bigscreen/client';
import { REMOTE_CATALOG_BASE } from '../../bigscreen/protocol';
import { BigScreenLoader, type LoadStep } from './BigScreenLoader';
import { RemoteLogin } from './RemoteLogin';
import { ScanToasts } from './ScanToasts';
import { useRemoteState } from './ConnectionIndicator';

/**
 * Big Screen im Browser (PLAN.md M18): Anmelden → Katalog vom Handy (nur wenn der Stand
 * neu ist) → Sammlung & Decks → die App. Läuft die Anmeldung ab, legt sich die Anmeldeseite
 * über die App; nach dem Anmelden geht es an derselben Stelle weiter.
 */
export function RemoteRoot({ client }: { client: RemoteClient }) {
  const st = useRemoteState(client);
  const [step, setStep] = useState<LoadStep>({ phase: 'katalog', progress: null });
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    void client.check();
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
      // Genau den Stand des Handys — auch wenn hier ein anderer liegt.
      if (local !== remote.catalogVersion) {
        setStep({ phase: 'katalog', progress: null });
        await applyUpdate(remote, { base, gzip, onProgress: (progress) => setStep({ phase: 'katalog', progress }) });
        invalidateNameIndex();
        invalidateSearchIndex();
      }
      const ver = remote.catalogVersion;
      const extras = (remote.counts.combos ?? 0) + (remote.counts.precons ?? 0) || 1;
      let comboDone = 0;
      setStep({ phase: 'extras', done: 0, total: extras });
      await syncCombos(base, ver, (done) => {
        comboDone = done;
        setStep({ phase: 'extras', done, total: extras });
      }, gzip);
      await syncPrecons(base, ver, (done) => setStep({ phase: 'extras', done: comboDone + done, total: extras }), gzip);
      setStep({ phase: 'sammlung' });
      await client.connect();
      setStep({ phase: 'fertig' });
    } catch (e) {
      setError((e as Error).message || 'Laden fehlgeschlagen.');
    } finally {
      running.current = false;
    }
  }, [client, st.info.catalogGzip]);

  useEffect(() => {
    if (st.phase === 'laden') void load();
  }, [st.phase, load]);

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
      <ScanToasts />
      {st.phase === 'abgelaufen' && <RemoteLogin client={client} device={st.info.deviceName} overlay />}
    </>
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
