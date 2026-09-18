/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design-Tokens als CSS-Variablen (siehe src/index.css).
      // rgb(var(...) / <alpha-value>): so greifen Opacity-Modifier wie `bg-accent/70`.
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        // MTG-Farben (W/U/B/R/G) — semantisch, wechseln nicht mit dem Theme.
        mtg: {
          w: 'rgb(var(--c-mtg-w) / <alpha-value>)',
          u: 'rgb(var(--c-mtg-u) / <alpha-value>)',
          b: 'rgb(var(--c-mtg-b) / <alpha-value>)',
          r: 'rgb(var(--c-mtg-r) / <alpha-value>)',
          g: 'rgb(var(--c-mtg-g) / <alpha-value>)',
          c: 'rgb(var(--c-mtg-c) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
