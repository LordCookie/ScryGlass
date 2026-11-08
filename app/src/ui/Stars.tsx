import { PixelIcon } from './PixelIcon';

/** Kombo-Stufe als Pixel-Sterne (1–4, eigene Stufen, domain/combos): volle hell, leere gedämpft. */
export function Stars({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 gap-[var(--px)] ${className}`} role="img" aria-label={`${n} von 4 Sternen`}>
      {[1, 2, 3, 4].map((i) => (
        <PixelIcon key={i} name={i <= n ? 'star' : 'starEmpty'} className={i <= n ? 'text-accent' : 'text-muted/50'} />
      ))}
    </span>
  );
}
