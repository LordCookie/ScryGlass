/** Mana- und Farbdarstellung (klein, framework-nah, keine externen Icon-Assets). */

const COLOR_BG: Record<string, string> = {
  W: 'bg-mtg-w text-black',
  U: 'bg-mtg-u text-white',
  B: 'bg-mtg-b text-white',
  R: 'bg-mtg-r text-white',
  G: 'bg-mtg-g text-white',
  C: 'bg-mtg-c text-black',
};

const COLOR_LABEL: Record<string, string> = {
  W: 'W', U: 'U', B: 'B', R: 'R', G: 'G', C: 'C',
};

/** Ein einzelnes Mana-Symbol (Farbe oder generische Zahl). */
function Sym({ token }: { token: string }) {
  const isColor = token in COLOR_BG;
  const cls = isColor ? COLOR_BG[token] : 'bg-muted/30 text-text';
  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none ${cls}`}
    >
      {isColor ? COLOR_LABEL[token] : token}
    </span>
  );
}

/** Rendert einen Manakosten-String wie "{1}{U}{U}" als Symbolreihe. */
export function ManaCost({ cost }: { cost: string }) {
  if (!cost) return null;
  const tokens = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5 align-middle">
      {tokens.map((t, i) => (
        <Sym key={i} token={t.replace('/', '')} />
      ))}
    </span>
  );
}

/** Kleine Farb-Punkte für die Farbidentität. */
export function ColorPips({ colors }: { colors: readonly string[] }) {
  const list = colors.length > 0 ? colors : ['C'];
  return (
    <span className="inline-flex items-center gap-0.5">
      {list.map((c) => (
        <span
          key={c}
          title={c}
          className={`inline-block h-2.5 w-2.5 rounded-full ${COLOR_BG[c]?.split(' ')[0] ?? 'bg-mtg-c'}`}
        />
      ))}
    </span>
  );
}
