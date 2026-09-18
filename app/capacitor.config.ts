import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor-Konfiguration für die native App-Verpackung (PLAN.md § 9).
 * webDir = Vite-Build-Ausgabe (`dist`). Dieselbe framework-freie Domäne läuft
 * unverändert im WebView.
 */
const config: CapacitorConfig = {
  appId: 'com.lordcookie.scryglass',
  appName: 'ScryGlass',
  webDir: 'dist',
  // Peer-Scanning spricht native HTTP-Server im LAN an (http://192.168.x.y) —
  // CapacitorHttp umgeht Mixed-Content/CORS (PLAN.md § 8, Android-Fallstricke).
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
