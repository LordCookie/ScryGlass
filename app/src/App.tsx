import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import {
  syncOnStartup, applyUpdate, getLocalCatalogVersion, CATALOG_BASE_URL,
  type CatalogVersion, type SyncProgress,
} from './data/catalog';
import { invalidateNameIndex } from './data/matcher';
import { invalidateSearchIndex } from './data/search';
import { syncHashes, loadHashIndex } from './data/imageHash';
import { getCachedNextSet, refreshNextSet } from './data/nextSet';
import { nextSetLabel, type UpcomingSet } from './domain/nextSet';
import { initFeedbackPrefs } from './native/feedback';
import { ScannerPanel } from './ui/ScannerPanel';
import { CollectionView } from './ui/CollectionView';
import { DecksPanel } from './ui/DecksPanel';
import { SearchPanel } from './ui/SearchPanel';
import { PixelIcon } from './ui/PixelIcon';
import { MorePanel } from './ui/MorePanel';

type Tab = 'scan' | 'sammlung' | 'decks' | 'suche' | 'mehr';
type Gate = 'checking' | 'importing' | 'ready' | 'offline';

// Import-Phasen als Pips (DESIGN.md § 5 A1). Reihenfolge = Pipeline-Reihenfolge.
const PHASES: SyncProgress['phase'][] = ['cards', 'printings', 'names', 'trigrams'];
const PHASE_LABEL: Record<SyncProgress['phase'], string> = {
  cards: 'Karten',
  printings: 'Editionen',
  names: 'Namen',
  trigrams: 'Index',
};
const nfDe = new Intl.NumberFormat('de-DE');

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'sammlung', label: 'Sammlung', icon: '▤' },
  { key: 'scan', label: 'Scanner', icon: '⛶' },
  { key: 'decks', label: 'Decks', icon: '♦' },
  // Pixel-Lupe statt Emoji; 2 px je Icon-Pixel = so hoch wie die Glyphen daneben.
  { key: 'suche', label: 'Suche', icon: <PixelIcon name="search" unit="2px" /> },
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
    invalidateSearchIndex();
    let ready = true;
    if (res.status === 'offline' && !local) { setGate('offline'); ready = false; }
    else if (res.status === 'update-available') { setUpdate(res.remote ?? null); setGate('ready'); }
    else setGate('ready');
    // Bild-Hash-Index (Scanner v2) best-effort im Hintergrund nachladen.
    if (ready) {
      const ver = await getLocalCatalogVersion();
      void syncHashes(CATALOG_BASE_URL, ver).then(() => void loadHashIndex());
    }
  }

  useEffect(() => { void runSync(); }, []);
  // Vibrations-Einstellung (unter „Mehr") gleich beim Start laden — gilt app-weit.
  useEffect(() => { void initFeedbackPrefs(); }, []);

  async function doUpdate() {
    if (!update) return;
    setApplying(true);
    await applyUpdate(update, { onProgress: setProgress });
    invalidateNameIndex();
    invalidateSearchIndex();
    const ver = await getLocalCatalogVersion();
    void syncHashes(CATALOG_BASE_URL, ver).then(() => void loadHashIndex());
    setUpdate(null);
    setProgress(null);
    setApplying(false);
  }

  if (gate === 'checking') {
    return <Splash title="Katalog wird geprüft…" />;
  }
  if (gate === 'importing') {
    return <ImportScreen progress={progress} />;
  }
  if (gate === 'offline') {
    return (
      <Splash title="Kein Katalog" subtitle="Für den ersten Start ist einmalig Internet nötig.">
        <button onClick={() => void runSync()} className="pxbtn pxbtn-primary mt-6 font-hud text-[10px]">
          Erneut versuchen
        </button>
      </Splash>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col">
      <header className="flex items-center gap-3 px-4 pb-3 pt-4">
        <h1 className="font-hud text-sm">
          <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
        </h1>
        <NextSetBadge />
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

      <main className="flex-1 px-4 pb-28">
        {tab === 'scan' && <ScannerPanel />}
        {tab === 'sammlung' && <CollectionView />}
        {tab === 'decks' && <DecksPanel />}
        {tab === 'suche' && <SearchPanel />}
        {tab === 'mehr' && <MorePanel />}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t-2 border-fill bg-surface"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex flex-1 flex-col items-center gap-1 py-3 font-mono text-xs ${
                  active ? 'bg-titlebar text-paper' : 'text-muted hover:text-text'
                }`}
              >
                {/* Aktiver Tab: heller Balken oben drauf (mehr Highlight). */}
                {active && <span className="absolute inset-x-0 top-0 h-[calc(var(--px)*1)] bg-paper" />}
                <span className="flex h-6 items-center text-2xl leading-none">{t.icon}</span>
                <span>{t.label}</span>
                {/* Peer-Eingang liegt jetzt unter „Mehr" → Badge dort. */}
                {t.key === 'mehr' && inboxCount > 0 && (
                  <span className="absolute right-1/5 top-1.5 bg-danger px-1.5 font-hud text-[8px] text-paper">{inboxCount}</span>
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/**
 * Header-Untertitel: Countdown zum nächsten regulären MTG-Set (Quelle: Scryfall
 * `/sets`, gecacht in Dexie). Bis Daten da sind (bzw. offline ohne Cache) fällt es
 * still auf „MTG · local-first" zurück.
 */
function NextSetBadge() {
  const [next, setNext] = useState<UpcomingSet | null>(null);
  useEffect(() => {
    let alive = true;
    void getCachedNextSet().then((c) => { if (alive && c) setNext(c); });
    void refreshNextSet().then((n) => { if (alive && n) setNext(n); });
    return () => { alive = false; };
  }, []);
  const label = nextSetLabel(next, new Date());
  if (!label) return <span className="font-mono text-xs text-muted">MTG · local-first</span>;
  return (
    <span className="font-mono text-xs text-muted" title={next ? `${next.name} · ${next.releasedAt}` : undefined}>
      {label}
    </span>
  );
}

function Splash({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 text-center">
      <h1 className="font-hud text-xl">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
      </h1>
      <p className="mt-6 font-mono text-lg text-text">{title}</p>
      {subtitle && <p className="mt-1 font-mono text-sm text-muted">{subtitle}</p>}
      {children}
    </div>
  );
}

/**
 * Erstimport — der einzige laute Moment (DESIGN.md § 5 A1 / § 6). Phasen-Pips,
 * harter Fortschrittsbalken mit Foil-Sweep, echte Zahlen. „Das passiert nur einmal."
 */
function ImportScreen({ progress }: { progress: SyncProgress | null }) {
  const pct = progress ? Math.min(100, Math.round((progress.overallDone / Math.max(1, progress.overallTotal)) * 100)) : 0;
  const currentIdx = progress ? PHASES.indexOf(progress.phase) : 0;
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6">
      <h1 className="mb-8 font-hud text-lg">
        <span className="text-muted">Scry</span><span className="text-paper">Glass</span>
      </h1>
      <div className="frame w-full max-w-sm p-5">
        <p className="mb-5 font-hud text-[11px] leading-relaxed text-text">KATALOG WIRD GELADEN</p>

        {/* Phasen-Pips */}
        <div className="mb-4 flex items-center gap-3">
          {PHASES.map((p, i) => (
            <span key={p} className={`pip ${i < currentIdx || pct >= 100 ? 'on' : ''}`}
              style={i === currentIdx && pct < 100 ? { borderColor: 'rgb(var(--c-paper))' } : undefined} />
          ))}
        </div>

        {/* Fortschrittsbalken (8 Design-Pixel, DESIGN § 5 A1) mit Foil-Sweep. */}
        <div className="foil mb-2 w-full bg-elevated"
          style={{ height: 'max(10px, calc(var(--px) * 8))', border: 'calc(var(--px) * 1) solid rgb(var(--c-fill))' }}>
          <div className="h-full bg-fill" style={{ width: `${pct}%` }} />
        </div>

        {/* echte Zahl */}
        <p className="font-hud text-[10px] text-text">
          {progress ? `${nfDe.format(progress.overallDone)} / ${nfDe.format(progress.overallTotal)}` : '…'}
        </p>
        <p className="mt-1 font-mono text-sm text-muted">
          {progress ? PHASE_LABEL[progress.phase] : ''}
        </p>

        <p className="mt-5 font-mono text-sm text-muted">Das passiert nur einmal.</p>
      </div>
    </div>
  );
}
