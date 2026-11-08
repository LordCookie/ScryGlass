package com.lordcookie.scryglass;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Eigenes Peer-Scanning-Plugin registrieren (PLAN.md § 8).
        registerPlugin(PeerServerPlugin.class);
        // Native Scanner-Kamera: CameraX + ML-Kit-Texterkennung auf dem Gerät.
        registerPlugin(ScryCameraPlugin.class);
        // App-Update aus der App: APK prüfen (Prüfsumme, Signatur) und Installer öffnen.
        registerPlugin(AppUpdaterPlugin.class);
        // Big Screen: die App im Browser am PC, ausgeliefert vom Handy (PLAN.md M18).
        registerPlugin(BigScreenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
