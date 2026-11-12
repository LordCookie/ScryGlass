package com.lordcookie.scryglass

import android.content.res.AssetManager
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Big Screen (PLAN.md M18): Die App im Browser am PC, ausgeliefert vom Handy.
 *
 *   GET  /                 → App-Dateien aus den APK-Assets (SPA: Unbekanntes → index.html)
 *   GET  /bigscreen.json   → daran erkennt die Web-App den Fernbetrieb
 *   GET  /catalog/<datei>  → Katalog des Handys: aufgehobene .gz vom letzten Katalog-Update,
 *                            sonst der eingebaute aus den Assets
 *   GET  /img/<pfad>       → Kartenbild aus dem Zwischenspeicher des Handys, fehlende holt das
 *                            Handy bei Scryfall (M20); nur mit gültiger Sitzung
 *   *    /api/...          → an JS weitergereicht (Brücke), Antwort kommt per respond()
 *   WS   /api/events       → Änderungen live; Anmeldung wird vorher über JS geprüft
 *
 * Läuft in eigenen Threads; die WebView bleibt frei, der Scanner läuft weiter.
 */
class BigScreenServer(
    port: Int,
    private val assets: AssetManager,
    private val catalogDir: File,
    private val infoJson: () -> String,
    private val bridge: Bridge,
    private val images: CardImageCache,
) : NanoWSD(port) {

    /** Gültige Sitzungs-Cookies (von JS gesetzt, nur im Speicher) — für `/img`. */
    @Volatile var sessionTokens: Set<String> = emptySet()

    interface Bridge {
        /** Anfrage an JS geben; die Antwort kommt über [complete]. */
        fun request(id: String, data: JSONObject)
        fun socketOpened(socketId: String, sessionId: String)
        fun socketClosed(socketId: String, sessionId: String)
    }

    class Reply(val status: Int, val body: String, val headers: Map<String, String>)

    private class Pending {
        val latch = CountDownLatch(1)
        @Volatile var reply: Reply? = null
    }

    private val pending = ConcurrentHashMap<String, Pending>()
    private val sockets = ConcurrentHashMap<String, Socket>()
    /** Sitzung, die beim WebSocket-Handshake geprüft wurde (je Anfrage-Objekt). */
    private val handshakeSession = ConcurrentHashMap<IHTTPSession, String>()
    private val pinger: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

    init {
        // Ohne Ping schließt der Lese-Timeout ruhige WebSockets; der Browser antwortet von selbst.
        pinger.scheduleAtFixedRate({
            for (s in sockets.values) {
                try { s.ping(ByteArray(0)) } catch (_: Exception) { }
            }
        }, 20, 20, TimeUnit.SECONDS)
    }

    fun complete(id: String, reply: Reply) {
        val p = pending.remove(id) ?: return
        p.reply = reply
        p.latch.countDown()
    }

    /** An alle Sockets der Sitzungen (leer = alle). */
    fun send(data: String, sessions: Set<String>?) {
        for (s in sockets.values) {
            if (sessions == null || s.sessionId in sessions) {
                try { s.send(data) } catch (_: IOException) { }
            }
        }
    }

    fun closeSessions(sessions: Set<String>, last: String?) {
        for (s in sockets.values.filter { it.sessionId in sessions }) {
            try {
                if (last != null) s.send(last)
                s.close(WebSocketFrame.CloseCode.NormalClosure, "bye", false)
            } catch (_: IOException) { }
        }
    }

    override fun stop() {
        pinger.shutdownNow()
        for (s in sockets.values) {
            try { s.close(WebSocketFrame.CloseCode.GoingAway, "aus", false) } catch (_: IOException) { }
        }
        sockets.clear()
        for (p in pending.values) p.latch.countDown()
        pending.clear()
        super.stop()
    }

    // --- HTTP ---------------------------------------------------------------------

    override fun serve(session: IHTTPSession): Response {
        val path = session.uri ?: "/"
        if (isWebsocketRequested(session)) {
            if (path != "/api/events") return text(Response.Status.NOT_FOUND, "not found")
            // Erst über JS prüfen, ob die Sitzung (Cookie) gültig ist.
            val reply = ask(session, "GET", "/api/ws-auth", null)
            if (reply.status != 200) return jsonResponse(reply)
            val sessionId = try { JSONObject(reply.body).getString("session") } catch (e: Exception) { "" }
            if (sessionId.isEmpty()) return text(statusOf(401), "unauthorized")
            handshakeSession[session] = sessionId
            return try { super.serve(session) } finally { handshakeSession.remove(session) }
        }
        return serveHttp(session)
    }

    override fun serveHttp(session: IHTTPSession): Response {
        val path = session.uri ?: "/"
        return try {
            when {
                path.startsWith("/api/") -> jsonResponse(ask(session, session.method.name, path, readBody(session)))
                path == "/bigscreen.json" -> noStore(newFixedLengthResponse(Response.Status.OK, "application/json", infoJson()))
                path.startsWith("/catalog/") -> serveCatalog(path.removePrefix("/catalog/"))
                path.startsWith("/img/") -> serveImage(session, path.removePrefix("/img/"))
                session.method == Method.GET || session.method == Method.HEAD -> serveAsset(path)
                else -> text(Response.Status.METHOD_NOT_ALLOWED, "method not allowed")
            }
        } catch (e: Exception) {
            text(Response.Status.INTERNAL_ERROR, e.message ?: "Fehler")
        }
    }

    /** Anfrage an JS und auf die Antwort warten — höchstens 15 s (App im Hintergrund → 503). */
    private fun ask(session: IHTTPSession, method: String, path: String, body: String?): Reply {
        val id = UUID.randomUUID().toString()
        val p = Pending()
        pending[id] = p
        val q = session.queryParameterString
        val data = JSONObject()
            .put("id", id)
            .put("method", method)
            .put("path", if (q.isNullOrEmpty()) path else "$path?$q")
            .put("cookie", session.headers["cookie"] ?: "")
            .put("remote", session.remoteIpAddress ?: "")
            .put("userAgent", session.headers["user-agent"] ?: "")
        if (body != null) data.put("body", body)
        bridge.request(id, data)
        val ok = p.latch.await(15, TimeUnit.SECONDS)
        pending.remove(id)
        return p.reply ?: Reply(503, if (ok) """{"error":"Big Screen ist aus."}""" else """{"error":"Handy antwortet nicht — App am Handy öffnen."}""", emptyMap())
    }

    /**
     * Gepackt übertragen, wenn der Browser es kann (M20): NanoHTTPD packt von sich aus nur
     * Text und `…/json`, nicht den eingebauten Katalog (`application/x-ndjson`, ~80 MB
     * roh, gepackt etwa ein Viertel). Bereits gepackte `.gz` und Bilder bleiben, wie sie sind.
     */
    override fun useGzipWhenAccepted(r: Response): Boolean {
        val mime = r.mimeType?.lowercase() ?: return false
        return mime.startsWith("text/") || mime.contains("json")
    }

    private fun jsonResponse(r: Reply): Response {
        val res = newFixedLengthResponse(statusOf(r.status), "application/json; charset=utf-8", r.body)
        for ((k, v) in r.headers) res.addHeader(k, v)
        return noStore(res)
    }

    private val catalogNames = setOf(
        "version.json",
        "cards.ndjson", "printings.ndjson", "names.ndjson", "combos.ndjson", "precons.ndjson",
        "cards.ndjson.gz", "printings.ndjson.gz", "names.ndjson.gz", "combos.ndjson.gz", "precons.ndjson.gz",
    )

    private fun serveCatalog(name: String): Response {
        if (name !in catalogNames) return text(Response.Status.NOT_FOUND, "unknown file")
        val staged = File(catalogDir, name)
        if (staged.isFile) {
            val mime = if (name.endsWith(".gz")) "application/gzip" else if (name.endsWith(".json")) "application/json" else "application/x-ndjson"
            return noStore(newFixedLengthResponse(Response.Status.OK, mime, FileInputStream(staged), staged.length()))
        }
        return serveAssetFile("public/catalog/$name") ?: text(Response.Status.NOT_FOUND, "not staged")
    }

    private fun sessionCookie(session: IHTTPSession): String? {
        val raw = session.headers["cookie"] ?: return null
        for (part in raw.split(';')) {
            val kv = part.trim()
            if (kv.startsWith("sg_session=")) return kv.removePrefix("sg_session=")
        }
        return null
    }

    private fun serveImage(session: IHTTPSession, rel: String): Response {
        if (session.method != Method.GET && session.method != Method.HEAD) return text(Response.Status.METHOD_NOT_ALLOWED, "method not allowed")
        val token = sessionCookie(session)
        if (token == null || token !in sessionTokens) return text(statusOf(401), "unauthorized")
        if (!images.validPath(rel)) return text(Response.Status.NOT_FOUND, "unknown image")
        return when (val r = images.get(rel)) {
            is CardImageCache.Result.Hit -> {
                val mime = if (rel.endsWith(".png")) "image/png" else "image/jpeg"
                val res = newFixedLengthResponse(Response.Status.OK, mime, FileInputStream(r.file), r.file.length())
                // Der Browser darf sie behalten; Scryfall ersetzt Bilder selten (Vorschau → Druck).
                res.addHeader("Cache-Control", "private, max-age=2592000")
                res
            }
            CardImageCache.Result.NotFound -> text(Response.Status.NOT_FOUND, "no image")
            CardImageCache.Result.Offline -> noStore(text(statusOf(504), "Scryfall nicht erreichbar"))
        }
    }

    private fun serveAsset(rawPath: String): Response {
        val clean = rawPath.substringBefore('?').trimStart('/').ifEmpty { "index.html" }
        if (clean.contains("..")) return text(Response.Status.FORBIDDEN, "forbidden")
        // Den Service Worker gibt es im Fernbetrieb nicht (ohne HTTPS ohnehin gesperrt).
        if (clean == "sw.js" || clean == "registerSW.js") return text(Response.Status.NOT_FOUND, "no service worker")
        val res = serveAssetFile("public/$clean")
        if (res != null) {
            if (clean == "index.html") noStore(res)
            else if (clean.startsWith("assets/")) res.addHeader("Cache-Control", "public, max-age=31536000, immutable")
            return res
        }
        // SPA: Pfade ohne Endung → index.html
        if (!clean.substringAfterLast('/').contains('.')) {
            return noStore(serveAssetFile("public/index.html") ?: text(Response.Status.NOT_FOUND, "no app"))
        }
        return text(Response.Status.NOT_FOUND, "not found")
    }

    private fun serveAssetFile(assetPath: String): Response? {
        val stream: InputStream = try { assets.open(assetPath) } catch (e: IOException) { return null }
        val mime = mimeOf(assetPath)
        // Länge nur bei unkomprimierten Assets bekannt; sonst stückweise (Chunked).
        val length = try { assets.openFd(assetPath).use { it.length } } catch (e: Exception) { -1L }
        return if (length >= 0) newFixedLengthResponse(Response.Status.OK, mime, stream, length)
        else newChunkedResponse(Response.Status.OK, mime, stream)
    }

    private fun mimeOf(path: String): String = when (path.substringAfterLast('.').lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json"
        "webmanifest" -> "application/manifest+json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        "woff" -> "font/woff"
        "ttf" -> "font/ttf"
        "wasm" -> "application/wasm"
        "ndjson" -> "application/x-ndjson"
        "gz" -> "application/gzip"
        "txt" -> "text/plain; charset=utf-8"
        else -> "application/octet-stream"
    }

    private fun noStore(r: Response): Response {
        r.addHeader("Cache-Control", "no-store")
        return r
    }

    private fun text(status: Response.IStatus, body: String): Response =
        newFixedLengthResponse(status, "text/plain; charset=utf-8", body)

    private fun readBody(session: IHTTPSession): String? {
        if (session.method != Method.POST && session.method != Method.PUT) return null
        val len = session.headers["content-length"]?.toIntOrNull() ?: 0
        if (len <= 0) return ""
        if (len > 64 * 1024 * 1024) throw IOException("Anfrage zu groß")
        val buf = ByteArray(len)
        var read = 0
        while (read < len) {
            val r = session.inputStream.read(buf, read, len - read)
            if (r <= 0) break
            read += r
        }
        return String(buf, 0, read, Charsets.UTF_8)
    }

    private fun statusOf(code: Int): Response.IStatus =
        Response.Status.lookup(code) ?: object : Response.IStatus {
            override fun getRequestStatus(): Int = code
            override fun getDescription(): String = "$code"
        }

    // --- WebSocket ----------------------------------------------------------------

    override fun openWebSocket(handshake: IHTTPSession): WebSocket {
        return Socket(handshake, handshakeSession[handshake] ?: "")
    }

    inner class Socket(handshake: IHTTPSession, val sessionId: String) : WebSocket(handshake) {
        val socketId: String = UUID.randomUUID().toString()

        override fun onOpen() {
            sockets[socketId] = this
            bridge.socketOpened(socketId, sessionId)
        }

        override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
            if (sockets.remove(socketId) != null) bridge.socketClosed(socketId, sessionId)
        }

        override fun onMessage(message: WebSocketFrame?) {
            // Der Browser schickt nichts über den Socket — Schreiben geht per POST.
        }

        override fun onPong(pong: WebSocketFrame?) {}

        override fun onException(exception: IOException?) {
            if (sockets.remove(socketId) != null) bridge.socketClosed(socketId, sessionId)
        }
    }
}
