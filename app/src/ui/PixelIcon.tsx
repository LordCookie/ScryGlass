/**
 * Pixel-Icons statt Emojis (DESIGN.md § 4): 1-Bit-Bitmaps, bei --px: 1 gezeichnet und
 * ganzzahlig skaliert — jedes Icon-Pixel ist genau ein Design-Pixel. Gezeichnet als
 * SVG mit harten Kanten in `currentColor`, damit das Icon die Textfarbe erbt
 * (hell = an, gedämpft = aus). '#' = Pixel, '.' = leer.
 */

const ICONS = {
  // Taschenlampe mit Lichtstrahlen (Kamera-Licht)
  torch: [
    '..#..##..#..',
    '...#.##.#...',
    '............',
    '..########..',
    '..#......#..',
    '..########..',
    '...######...',
    '....####....',
    '....#..#....',
    '....####....',
    '....####....',
    '....####....',
  ],
  // Handy mit Zickzack-Linien (Vibration)
  vibrate: [
    '...######...',
    '...#....#...',
    '.#.#....#.#.',
    '#..#....#..#',
    '.#.#....#.#.',
    '#..#....#..#',
    '.#.#....#.#.',
    '...#....#...',
    '...#....#...',
    '...#.##.#...',
    '...#....#...',
    '...######...',
  ],
} as const;

export type PixelIconName = keyof typeof ICONS;

/** Waagerechte Läufe zu einem Rechteck zusammenfassen (weniger SVG-Knoten). */
function runs(rows: readonly string[]): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x++;
        continue;
      }
      let w = 1;
      while (row[x + w] === '#') w++;
      out.push({ x, y, w });
      x += w;
    }
  });
  return out;
}

export function PixelIcon({ name, className = '', title }: { name: PixelIconName; className?: string; title?: string }) {
  const rows = ICONS[name];
  const h = rows.length;
  const w = rows[0].length;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      className={`inline-block shrink-0 align-middle ${className}`}
      style={{ width: `calc(var(--px) * ${w})`, height: `calc(var(--px) * ${h})` }}
    >
      {title && <title>{title}</title>}
      {runs(rows).map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}
