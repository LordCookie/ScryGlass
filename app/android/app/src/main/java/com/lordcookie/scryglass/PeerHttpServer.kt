package com.lordcookie.scryglass

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.File

/**
 * Eingebetteter HTTP-Server fürs Peer-Scanning (PLAN.md § 8, E4). Kein WebRTC, kein
 * Broker, kein Cloud-Hop — die Sender pushen ihre Körbe per HTTP POST.
 *
 * Endpunkte:
 *   GET  /hello                 → { deviceName, catalogVersion, protocolVersion, cardCount }
 *   GET  /catalog/:file         → NDJSON aus dem lokalen Katalog-Verzeichnis (optional)
 *   POST /basket                → Token prüfen, Body an Callback (idempotent per basketId)
 *   GET  /basket/:id/status     → { status, accepted, rejected }
 */
class PeerHttpServer(
    port: Int,
    private val token: String,
    private val helloJson: () -> String,
    private val onBasket: (String) -> Unit,
    private val catalogDir: File? = null,
) : NanoHTTPD(port) {

    private data class BasketStatus(var status: String, var accepted: Int, var rejected: Int)

    // basketId → Status. Dedup: ein bereits bekannter Korb wird nicht doppelt zugestellt.
    private val baskets = HashMap<String, BasketStatus>()

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri.trimEnd('/')
        return try {
            when {
                session.method == Method.GET && uri == "/hello" ->
                    json(Response.Status.OK, helloJson())

                session.method == Method.GET && uri.startsWith("/catalog/") ->
                    serveCatalog(uri.removePrefix("/catalog/"))

                session.method == Method.POST && uri == "/basket" ->
                    handleBasket(session)

                session.method == Method.GET && uri.startsWith("/basket/") && uri.endsWith("/status") ->
                    handleStatus(uri.removePrefix("/basket/").removeSuffix("/status"))

                else -> json(Response.Status.NOT_FOUND, """{"error":"not found"}""")
            }
        } catch (e: Exception) {
            json(Response.Status.INTERNAL_ERROR, """{"error":"${e.message}"}""")
        }
    }

    private fun handleBasket(session: IHTTPSession): Response {
        // Token prüfen (kein Krypto — nur gegen versehentliches Fremd-Pushen, § 8).
        val given = session.headers["x-session-token"]
        if (given != token) {
            return json(statusOf(401), """{"error":"invalid token"}""")
        }
        val body = readBody(session)
        val obj = JSONObject(body)
        val basketId = obj.getString("basketId")
        val entries = obj.optJSONArray("entries")
        val count = entries?.length() ?: 0

        // Idempotent: schon bekannter Korb → 409, aber kein Fehler für den Sender.
        if (baskets.containsKey(basketId)) {
            return json(statusOf(409), """{"accepted":$count,"basketId":"$basketId"}""")
        }
        baskets[basketId] = BasketStatus("received", count, 0)
        onBasket(body)
        return json(Response.Status.OK, """{"accepted":$count,"basketId":"$basketId"}""")
    }

    private fun handleStatus(basketId: String): Response {
        val s = baskets[basketId] ?: return json(Response.Status.OK, """{"status":"received","accepted":0,"rejected":0}""")
        return json(Response.Status.OK, """{"status":"${s.status}","accepted":${s.accepted},"rejected":${s.rejected}}""")
    }

    private fun serveCatalog(file: String): Response {
        val dir = catalogDir
        if (dir == null) {
            return json(statusOf(503), """{"error":"catalog serving not enabled"}""")
        }
        // Nur erlaubte Dateinamen (kein Path-Traversal).
        val allowed = setOf("cards.ndjson", "printings.ndjson", "names.ndjson", "trigrams.ndjson", "version.json")
        if (file !in allowed) return json(Response.Status.NOT_FOUND, """{"error":"unknown file"}""")
        val f = File(dir, file)
        if (!f.exists()) return json(statusOf(503), """{"error":"catalog not staged"}""")
        val mime = if (file.endsWith(".json")) "application/json" else "application/x-ndjson"
        return newChunkedResponse(Response.Status.OK, mime, f.inputStream())
    }

    /** Die vom Sender gestellte Statusabfrage soll den echten Review-Fortschritt sehen. */
    fun setBasketStatus(basketId: String, status: String, accepted: Int, rejected: Int) {
        baskets[basketId] = BasketStatus(status, accepted, rejected)
    }

    private fun readBody(session: IHTTPSession): String {
        val len = session.headers["content-length"]?.toIntOrNull() ?: 0
        if (len <= 0) return ""
        val buf = ByteArray(len)
        var read = 0
        while (read < len) {
            val r = session.inputStream.read(buf, read, len - read)
            if (r <= 0) break
            read += r
        }
        return String(buf, 0, read, Charsets.UTF_8)
    }

    private fun json(status: Response.IStatus, body: String): Response =
        newFixedLengthResponse(status, "application/json", body)

    /** NanoHTTPD kennt nur eine Teilmenge der Status-Codes als Enum — Rest als custom. */
    private fun statusOf(code: Int): Response.IStatus = object : Response.IStatus {
        override fun getRequestStatus(): Int = code
        override fun getDescription(): String = when (code) {
            401 -> "401 Unauthorized"
            409 -> "409 Conflict"
            503 -> "503 Service Unavailable"
            else -> "$code"
        }
    }
}
