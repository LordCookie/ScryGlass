package com.lordcookie.scryglass

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.view.WindowManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Capacitor-Brücke zum Big-Screen-Server (PLAN.md M18). Die Logik (Anmeldung, Daten)
 * steckt in JS (src/bigscreen/host.ts); hier nur Netz, Dateien und Wachmodus.
 *
 * Ereignisse an JS: `request` (Anfrage an /api/…), `socketOpen`, `socketClose`.
 */
@CapacitorPlugin(name = "BigScreen")
class BigScreenPlugin : Plugin() {

    private var server: BigScreenServer? = null
    private var wifiLock: WifiManager.WifiLock? = null

    /** Ordner mit den vom Katalog-Update aufgehobenen Dateien (siehe catalogStage in JS). */
    private fun catalogDir(): File = File(context.filesDir, "katalog/aktuell")

    @PluginMethod
    fun start(call: PluginCall) {
        val ports = call.getArray("ports")?.toList<Int>() ?: listOf(8780, 8781, 8782, 8783, 8784, 8785)
        val deviceName = call.getString("deviceName") ?: "Handy"
        val appVersion = call.getString("appVersion") ?: ""
        stopServer()

        val dir = catalogDir()
        val info = {
            val gz = File(dir, "cards.ndjson.gz").isFile && File(dir, "version.json").isFile
            JSONObject()
                .put("mode", "bigscreen")
                .put("deviceName", deviceName)
                .put("appVersion", appVersion)
                .put("catalogGzip", gz)
                .toString()
        }
        val bridge = object : BigScreenServer.Bridge {
            override fun request(id: String, data: JSONObject) {
                notifyListeners("request", JSObject.fromJSONObject(data))
            }

            override fun socketOpened(socketId: String, sessionId: String) {
                val d = JSObject()
                d.put("socket", socketId)
                d.put("session", sessionId)
                notifyListeners("socketOpen", d)
            }

            override fun socketClosed(socketId: String, sessionId: String) {
                val d = JSObject()
                d.put("socket", socketId)
                d.put("session", sessionId)
                notifyListeners("socketClose", d)
            }
        }

        var lastError: String? = null
        for (port in ports) {
            val srv = BigScreenServer(port, context.assets, dir, info, bridge)
            try {
                // Lese-Timeout 60 s; der Server pingt WebSockets alle 20 s an.
                srv.start(60_000, false)
                server = srv
                val ip = localIpAddress() ?: "0.0.0.0"
                val ret = JSObject()
                ret.put("url", "http://$ip:$port")
                ret.put("ip", ip)
                ret.put("port", port)
                call.resolve(ret)
                return
            } catch (e: IOException) {
                lastError = e.message
                srv.stop()
            }
        }
        call.reject("Kein freier Port (8780–8785): $lastError")
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopServer()
        call.resolve()
    }

    /** Antwort von JS auf eine weitergereichte Anfrage. */
    @PluginMethod
    fun respond(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id fehlt"); return }
        val headers = HashMap<String, String>()
        call.getObject("headers")?.let { h -> for (k in h.keys()) headers[k] = h.getString(k) ?: "" }
        server?.complete(id, BigScreenServer.Reply(call.getInt("status") ?: 200, call.getString("body") ?: "", headers))
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val data = call.getString("data") ?: run { call.reject("data fehlt"); return }
        val sessions = call.getArray("sessions")?.toList<String>()?.toSet()
        server?.send(data, sessions)
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val sessions = call.getArray("sessions")?.toList<String>()?.toSet() ?: emptySet()
        server?.closeSessions(sessions, call.getString("data"))
        call.resolve()
    }

    /** Wachmodus: Bildschirm an + WLAN ohne Stromsparen; `dim` = Ruhebild (nur dieses Fenster). */
    @PluginMethod
    fun setAwake(call: PluginCall) {
        val on = call.getBoolean("on") ?: false
        val dim = call.getBoolean("dim") ?: false
        activity.runOnUiThread {
            val w = activity.window
            if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val lp = w.attributes
            lp.screenBrightness = if (on && dim) 0.01f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            w.attributes = lp
        }
        setWifiLock(on)
        call.resolve()
    }

    @PluginMethod
    fun battery(call: PluginCall) {
        val intent: Intent? = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val ret = JSObject()
        if (intent != null) {
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            if (level >= 0 && scale > 0) ret.put("level", level.toDouble() / scale)
            ret.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun getIp(call: PluginCall) {
        val ret = JSObject()
        ret.put("ip", localIpAddress() ?: "")
        call.resolve(ret)
    }

    /** Absoluter Pfad des Katalog-Ordners (JS legt dort die geladenen Dateien ab). */
    @PluginMethod
    fun catalogPath(call: PluginCall) {
        val ret = JSObject()
        ret.put("path", catalogDir().absolutePath)
        call.resolve(ret)
    }

    private fun setWifiLock(on: Boolean) {
        try {
            if (on) {
                if (wifiLock?.isHeld == true) return
                val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wifiLock = wm.createWifiLock(mode, "ScryGlass:BigScreen").also { it.setReferenceCounted(false); it.acquire() }
            } else {
                wifiLock?.let { if (it.isHeld) it.release() }
                wifiLock = null
            }
        } catch (_: Exception) {
            // ohne WLAN-Lock geht es auch, nur evtl. träger
        }
    }

    private fun stopServer() {
        server?.stop()
        server = null
    }

    private fun localIpAddress(): String? {
        try {
            for (intf in NetworkInterface.getNetworkInterfaces()) {
                if (!intf.isUp || intf.isLoopback) continue
                for (addr in intf.inetAddresses) {
                    if (!addr.isLoopbackAddress && addr is Inet4Address && addr.isSiteLocalAddress) return addr.hostAddress
                }
            }
        } catch (_: Exception) { }
        return null
    }

    override fun handleOnDestroy() {
        stopServer()
        setWifiLock(false)
        super.handleOnDestroy()
    }
}
