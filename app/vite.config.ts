import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { readFileSync } from 'node:fs';

// App-Version einmal aus package.json — landet als __APP_VERSION__ im Bundle (Über-Seite).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

// Heimnetz-Freigabe fürs Handy: `LAN=1 npm run dev` bindet an 0.0.0.0 und schaltet
// HTTPS (selbstsigniert) ein — nötig, weil die Kamera (getUserMedia) nur in einem
// sicheren Kontext läuft (HTTPS oder localhost), NICHT über http://<LAN-IP>.
// Ohne LAN bleibt der Dev-Server http://localhost (Vorschaufenster unverändert).
const lan = process.env.LAN === '1' || process.env.LAN === 'true';

// https://vitejs.dev/config/
export default defineConfig({
  server: lan ? { host: true, port: 5174 } : { port: 5174 },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    ...(lan ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // Kartenbilder offline verfügbar machen (PLAN.md § 12: nichts im Repo/Bundle,
      // nur ein lokaler Cache auf dem Gerät). Bilder kommen vom Scryfall-CDN
      // (cards.scryfall.io). CacheFirst → einmal gesehen = offline verfügbar.
      workbox: {
        // Pixel-Schriften (§ 3) mit ins Precache, damit sie offline sofort da sind.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Der Katalog (NDJSON) kann groß sein → aus dem Precache-Größenlimit raus.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cards\.scryfall\.io\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'card-images',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'ScryGlass',
        short_name: 'ScryGlass',
        description: 'Local-first MTG-Sammlungs- und Deckbau-App (inoffizielles Fan-Tool)',
        theme_color: '#250E47',
        background_color: '#250E47',
        display: 'standalone',
        start_url: '/',
        // Pixel-Icon (design/make_icons.py); „maskable": Motiv liegt in der Sicherheitszone.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
