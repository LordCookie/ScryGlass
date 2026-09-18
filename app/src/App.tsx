import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import {
  syncOnStartup, applyUpdate, getLocalCatalogVersion,
  type CatalogVersion, type SyncProgress,
} from './data/catalog';
import { invalidateNameIndex } from './data/matcher';
import { ScannerPanel } from './ui/ScannerPanel';
import { CollectionView } from './ui/CollectionView';
import { DecksPanel } from './ui/DecksPanel';
import { PeerPanel } from './ui/PeerPanel';
import { MorePanel } from './ui/MorePanel';

type Tab = 'scan' | 'sammlung' | 'decks' | 'peer' | 'mehr';
type Gate = 'checking' | 'importing' | 'ready' | 'offline';

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'sammlung', label: 'Sammlung', icon: '▤' },
  { key: 'scan', label: 'Scanner', icon: '⛶' },
  { key: 'decks', label: 'Decks', icon: '♦' },
  { key: 'peer', label: 'Peer', icon: '⇄' },
  { key: 'mehr', label: 'Mehr', icon: '⋯' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('sammlung');
  const [gate, setGate] = useState<Gate>('checking');
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [update, setUpdate] = useState<CatalogVersion | null>(null);
  const [applying, setApplying] = useState(false);

  const inboxCount = useLiveQuery(() => db.inbox.count(), []) ?? 0;

  async function runSync() {
    const local = await getLocalCatalogVersion();
    setGate(local ? 'ready' : 'checking');
    const res = await syncOnStartup({ onProgress: (p) => { setProgress(p); setGate('importing'); } });
    setProgress(null);
    invalidateNameIndex();
    if (res.status === 'offline' && !local) setGate('offline');
    else if (res.status === 'update-available') { setUpdate(res.remote ?? null); setGate('ready'); }
    else setGate('ready');
  }

  useEffect(() => { void runSync(); }, []);

  async function doUpdate() {
    if (!update) return;
    setApplying(true);
    await applyUpdate(update, { onProgress: setProgress });
    invalidateNameIndex();
    setUpdate(null);
    setProgress(null);
    setApplying(false);
  }

  if (gate === 'checking') {
    return <Splash title="ScryGlass" subtitle="Katalog wird geprüft…" />;
  }
  if (gate === 'importing') {
    const pct = progress ? Math.round((progress.overallDone / Math.max(1, progress.overallTotal)) * 100) : 0;
    return (
      <Splash title="Katalog wird geladen" subtitle={`Einmalig — ${pct}% (${progress?.phase ?? ''})`}>
        <div className="mt-3 h-2 w-64 overflow-hidden rounded-full bg-surface">
          <div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </Splash>
    );
  }
  if (gate === 'offline') {
    return (
      <Splash title="Kein Katalog" subtitle="Für den ersten Start ist einmalig Internet nötig.">
        <button onClick={() => void runSync()} className="mt-4 rounded bg-accent px-4 py-2 font-mono text-sm text-on-accent">
          Erneut versuchen
        </button>
      </Splash>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col">
      <header className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h1 className="font-mono text-xl font-bold tracking-tight">Scry<span className="text-accent">Glass</span></h1>
        <span className="font-mono text-[10px] text-muted">MTG · local-first</span>
      </header>

      {update && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-md bg-accent/10 px-3 py-2 font-mono text-xs text-accent">
          <span className="flex-1">Katalog-Update verfügbar.</span>
          {applying ? (
            <span>{progress ? Math.round((progress.overallDone / Math.max(1, progress.overallTotal)) * 100) : 0}%</span>
          ) : (
            <>
              <button onClick={() => void doUpdate()} className="rounded bg-accent px-2 py-1 text-on-accent">Laden</button>
              <button onClick={() => setUpdate(null)} className="text-muted hover:text-text">später</button>
            </>
          )}
        </div>
      )}

      <main className="flex-1 px-4 pb-24">
        {tab === 'scan' && <ScannerPanel />}
        {tab === 'sammlung' && <CollectionView />}
        {tab === 'decks' && <DecksPanel />}
        {tab === 'peer' && <PeerPanel />}
        {tab === 'mehr' && <MorePanel />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 font-mono text-[11px] ${tab === t.key ? 'text-accent' : 'text-muted'}`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              {t.label}
              {t.key === 'peer' && inboxCount > 0 && (
                <span className="absolute right-1/4 top-1 rounded-full bg-danger px-1.5 text-[9px] text-white">{inboxCount}</span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Splash({ title, subtitle, children }: { title: string; subtitle: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 text-center">
      <h1 className="font-mono text-3xl font-bold">Scry<span className="text-accent">Glass</span></h1>
      <p className="mt-1 font-mono text-lg">{title}</p>
      <p className="mt-1 font-mono text-sm text-muted">{subtitle}</p>
      {children}
    </div>
  );
}
