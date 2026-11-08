import { useEffect, useMemo, useState } from 'react';
import { loadComboIndex, loadComboNames, matchComboCards, type ComboNames } from '../data/combos';
import {
  findCombos, combosUsing, comboCards, comboResults, resultLabel, spellbookUrl, type ComboHit, type ComboIndex,
} from '../domain/combos';
import { Stars } from './Stars';

/**
 * Kombos in der Suche (M17) — ein Zusatz für die, die sie suchen. Ohne Suchtext: was sich
 * aus der eigenen Sammlung bauen lässt (oder fast). Mit Suchtext: Kombos mit dieser Karte,
 * eigene Karten markiert. Daten von Commander Spellbook, Sterne als eigene Einstufung.
 */

type Scope = 'besitz' | 'fast' | 'alle';
const PAGE = 30;
const nf = new Intl.NumberFormat('de-DE');

export function ComboSearch({ query, owned, onOpenCard }: {
  query: string;
  owned: Map<string, number> | undefined;
  onOpenCard: (oracleId: string) => void;
}) {
  const [ix, setIx] = useState<ComboIndex | null | undefined>(undefined);
  const [names, setNames] = useState<ComboNames | null>(null);
  const [scope, setScope] = useState<Scope>('besitz');
  const [minStars, setMinStars] = useState(1);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    let alive = true;
    void loadComboIndex().then(async (i) => {
      if (!alive) return;
      setIx(i);
      if (i) {
        const n = await loadComboNames(i);
        if (alive) setNames(n);
      }
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => setLimit(PAGE), [query, scope, minStars]);

  const have = useMemo(() => new Set(owned?.keys() ?? []), [owned]);
  const q = query.trim();
  const hits: ComboHit[] = useMemo(() => {
    if (!ix || !names) return [];
    let list: ComboHit[];
    if (q) {
      // Suche nach Karte: alle Kombos damit, fehlende Teile ausgewiesen.
      list = combosUsing(ix, matchComboCards(names, q)).map((i) => ({
        i,
        missing: comboCards(ix, i).filter((id) => !have.has(id)),
      }));
      if (scope === 'besitz') list = list.filter((h) => h.missing.length === 0);
      else if (scope === 'fast') list = list.filter((h) => h.missing.length === 1);
    } else {
      list = findCombos(ix, have, { maxMissing: scope === 'besitz' ? 0 : 1 });
      if (scope === 'fast') list = list.filter((h) => h.missing.length === 1);
    }
    return list.filter((h) => ix.store.stars[h.i] >= minStars);
  }, [ix, names, q, scope, minStars, have]);

  if (ix === undefined || (ix && !names)) return <p className="px-1 font-mono text-sm text-muted">Lade Kombos…</p>;
  if (ix === null) {
    return (
      <p className="px-1 font-mono text-sm text-muted">
        Die Kombo-Daten kommen mit dem nächsten Katalog-Update (Mehr → Katalog).
      </p>
    );
  }

  const scopes: { key: Scope; label: string }[] = [
    { key: 'besitz', label: 'Alle Teile im Besitz' },
    { key: 'fast', label: '1 Karte fehlt' },
    ...(q ? [{ key: 'alle' as const, label: 'Alle' }] : []),
  ];
  const effScope = !q && scope === 'alle' ? 'besitz' : scope;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
        {scopes.map((s) => (
          <button key={s.key} onClick={() => setScope(s.key)} aria-pressed={effScope === s.key}
            className={`px-2 py-1 ${effScope === s.key ? 'bg-fill text-paper' : 'bg-surface text-muted hover:text-text'}`}>
            {s.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-muted">
          ab
          {[1, 2, 3, 4].map((n) => (
            <button key={n} onClick={() => setMinStars(n)} aria-pressed={minStars === n} aria-label={`ab ${n} Sternen`}
              className={`px-1 py-1 ${minStars === n ? 'bg-fill' : 'bg-surface'}`}>
              <Stars n={n} />
            </button>
          ))}
        </span>
      </div>

      <p className="px-1 font-mono text-xs text-muted">
        {nf.format(hits.length)} {hits.length === 1 ? 'Kombo' : 'Kombos'}
        {q ? ` mit „${q}"` : effScope === 'besitz' ? ' aus deiner Sammlung' : ', denen eine Karte fehlt'}
      </p>

      <ul className="space-y-2">
        {hits.slice(0, limit).map((h) => (
          <ComboRowView key={ix.store.ids[h.i]} ix={ix} names={names!} hit={h} onOpenCard={onOpenCard} />
        ))}
      </ul>
      {hits.length > limit && (
        <button onClick={() => setLimit((l) => l + PAGE)}
          className="w-full bg-surface px-3 py-2 font-mono text-sm text-accent hover:bg-elevated">
          Mehr anzeigen ({nf.format(hits.length - limit)} weitere)
        </button>
      )}
      <p className="px-1 font-mono text-[10px] text-muted">
        Kombo-Daten von{' '}
        <a href="https://commanderspellbook.com" target="_blank" rel="noreferrer" className="text-accent underline">Commander Spellbook</a>
        {' '}(Stand {ix.store.meta.timestamp.slice(0, 10)}). Sterne: eigene Einstufung — vier gewinnen allein mit zwei
        Karten und wenig Mana, einer braucht noch etwas dazu.
      </p>
    </div>
  );
}

/** Mana, um die Kombo auszulösen, wenn die Karten liegen (nicht zum Wirken). */
export function manaLabel(mv: number): string {
  return mv > 0 ? `Auslösen: ${mv} Mana` : mv === 0 ? 'Auslösen ohne Mana' : 'Mana unbekannt';
}

function ComboRowView({ ix, names, hit, onOpenCard }: {
  ix: ComboIndex; names: ComboNames; hit: ComboHit; onOpenCard: (oracleId: string) => void;
}) {
  const s = ix.store;
  const cards = comboCards(ix, hit.i);
  const missing = new Set(hit.missing);
  const mv = s.mv[hit.i];
  return (
    <li className="rounded-lg bg-surface p-3 font-mono text-xs">
      <div className="mb-1 flex items-center gap-2">
        <Stars n={s.stars[hit.i]} />
        <span className="ml-auto text-muted">{manaLabel(mv)} · {s.need[hit.i]} Karten</span>
      </div>
      <ul className="mb-1">
        {cards.map((id) => (
          <li key={id}>
            <button onClick={() => onOpenCard(id)} className={`text-left hover:underline ${missing.has(id) ? 'text-danger' : 'text-text'}`}>
              {names.name.get(id) ?? id}
              {missing.has(id) && <span className="text-muted"> — fehlt</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-muted">{comboResults(ix, hit.i).map(resultLabel).join(' · ')}</p>
      <a href={spellbookUrl(s.ids[hit.i])} target="_blank" rel="noreferrer" className="text-accent underline">
        Ablauf bei Commander Spellbook
      </a>
    </li>
  );
}
