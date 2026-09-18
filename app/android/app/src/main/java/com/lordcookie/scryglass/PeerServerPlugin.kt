package com.lordcookie.scryglass

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Capacitor-Brücke zum eingebetteten Peer-HTTP-Server (PLAN.md § 8, § 8 Native-Plugin).
 * Der Server läuft nur, wenn jemand „Empfang starten" drückt — ohne aktive Session
 * kostet die Funktion nichts.
 */
@CapacitorPlugin(name = "PeerServer")
class PeerServerPlugin : Plugin() {

    private var server: PeerHttpServer? = null

    @PluginMethod
    fun start(call: PluginCall) {
        val token = call.getString("token") ?: run { call.reject("token required"); return }
        val port = call.getInt("port") ?: 8765
        val deviceName = call.getString("deviceName") ?: "ScryGlass"
        val catalogVersion = call.getString("catalogVersion") ?: ""
        val cardCount = call.getInt("cardCount") ?: 0

        stopServer()

        val ip = localIpAddress() ?: "0.0.0.0"
        val helloJson = {
            JSONObject()
                .put("deviceName", deviceName)
                .put("catalogVersion", catalogVersion)
                .put("protocolVersion", 1)
                .put("cardCount", cardCount)
                .toString()
        }
        val srv = PeerHttpServer(port, token, helloJson, { body -> onBasket(body) })
        try {
            // Server im Hintergrund; blockiert die WebView nicht — eigener Scan läuft weiter (§ 8).
            srv.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
        } catch (e: IOException) {
            call.reject("Port $port belegt: ${e.message}")
            return
        }
        server = srv

        val ret = JSObject()
        ret.put("url", "http://$ip:$port")
        ret.put("port", port)
        call.resolve(ret)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopServer()
        call.resolve()
    }

    @PluginMethod
    fun getLocalIp(call: PluginCall) {
        val ret = JSObject()
        ret.put("ip", localIpAddress() ?: "")
        call.resolve(ret)
    }

    /** Vom Review-UI: Sender-Statusabfrage soll den echten Fortschritt sehen. */
    @PluginMethod
    fun setBasketStatus(call: PluginCall) {
        val basketId = call.getString("basketId") ?: run { call.reject("basketId required"); return }
        server?.setBasketStatus(
            basketId,
            call.getString("status") ?: "reviewed",
            call.getInt("accepted") ?: 0,
            call.getInt("rejected") ?: 0,
        )
        call.resolve()
    }

    private fun onBasket(body: String) {
        val data = JSObject()
        data.put("data", body)
        notifyListeners("basketReceived", data)
    }

    private fun stopServer() {
        server?.stop()
        server = null
    }

    /** Erste site-local IPv4 (typisch die WLAN-Adresse) für die QR-URL. */
    private fun localIpAddress(): String? {
        try {
            for (intf in NetworkInterface.getNetworkInterfaces()) {
                if (!intf.isUp || intf.isLoopback) continue
                for (addr in intf.inetAddresses) {
                    if (!addr.isLoopbackAddress && addr is Inet4Address && addr.isSiteLocalAddress) {
                        return addr.hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            // ignorieren — Rückgabe null, der Aufrufer nimmt 0.0.0.0
        }
        return null
    }

    override fun handleOnDestroy() {
        stopServer()
        super.handleOnDestroy()
    }
}
