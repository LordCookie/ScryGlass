import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ownedByOracle } from '../data/cards';
import { ComboSearch } from './ComboSearch';
import { CardDetail } from './CardDetail';

/**
 * Eigener Reiter „Kombos" — nur im breiten Layout in der Leiste links (am Handy bleiben
 * Kombos ein Zusatz in der Suche, M17). Gleiche Ansicht wie dort, mit eigenem Suchfeld.
 */
export function CombosPanel() {
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const owned = useLiveQuery(() => ownedByOracle(), []);
  return (
    <section className={`space-y-3 ${detailId ? 'lg:pr-[30rem]' : ''}`}>
      <div className="rounded-lg bg-surface p-4">
        <h2 className="mb-2 font-hud text-sm text-text">KOMBOS</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-hotkey="search"
          placeholder="Kombos mit Karte (Name, deutsch oder englisch)…"
          className="w-full border-2 border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-paper"
        />
      </div>
      <ComboSearch query={query} owned={owned} onOpenCard={setDetailId} />
      {detailId && <CardDetail oracleId={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}
