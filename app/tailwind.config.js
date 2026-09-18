/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Design-Tokens (DESIGN.md § 2) als CSS-Variablen (siehe src/index.css).
      // rgb(var(...) / <alpha-value>): Opacity-Modifier wie `bg-fill/20` funktionieren.
      colors: {
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        elevated: 'rgb(var(--c-elevated) / <alpha-value>)',
        titlebar: 'rgb(var(--c-titlebar) / <alpha-value>)',
        pressed: 'rgb(var(--c-pressed) / <alpha-value>)',
        fill: 'rgb(var(--c-fill) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        paper: 'rgb(var(--c-paper) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'on-accent': 'rgb(var(--c-on-accent) / <alpha-value>)',
        // border-Klassen (border-border) nutzen violet-400.
        border: 'rgb(var(--c-fill) / <alpha-value>)',
        ok: 'rgb(var(--c-ok) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
      },
      fontFamily: {
        // Body/Standard = Pixelify Sans (DESIGN § 3). `font-mono` bleibt im Code
        // als „Pixel-Text" und mappt bewusst ebenfalls auf Pixelify (nie Press Start
        // 2P für deutsche Fließtexte — sonst Überlauf).
        sans: ['Pixelify Sans', 'system-ui', 'sans-serif'],
        mono: ['Pixelify Sans', 'ui-monospace', 'monospace'],
        // HUD/Zähler/kurze Labels = Press Start 2P (nur Zahlen & 1–2-Wort-Labels).
        hud: ['"Press Start 2P"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
