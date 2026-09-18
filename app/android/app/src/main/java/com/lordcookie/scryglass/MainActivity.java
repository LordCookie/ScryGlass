package com.lordcookie.scryglass;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Eigenes Peer-Scanning-Plugin registrieren (PLAN.md § 8).
        registerPlugin(PeerServerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
