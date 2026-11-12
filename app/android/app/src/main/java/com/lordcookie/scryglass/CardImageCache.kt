package com.lordcookie.scryglass

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger

/**
 * Kartenbilder für Big Screen (PLAN.md M20): Der Browser fragt das Handy, das Handy hebt
 * die Bilder im App-Cache auf und holt fehlende einmal bei Scryfall (cards.scryfall.io).
 * Höchstens [MAX_PARALLEL] Abrufe gleichzeitig, derselbe Pfad nur einmal; über
 * [MAX_BYTES] fliegen die am längsten nicht gebrauchten Bilder raus.
 */
class CardImageCache(private val dir: File, private val userAgent: String) {

    sealed class Result {
        class Hit(val file: File) : Result()
        object NotFound : Result()
        object Offline : Result()
    }

    private val inflight = ConcurrentHashMap<String, Any>()
    private val upstream = Semaphore(MAX_PARALLEL)
    private val writes = AtomicInteger(0)
    private val trimmer = Executors.newSingleThreadExecutor()

    /** Pfad wie bei Scryfall: `<größe>/<seite>/<a>/<b>/<id>.<endung>` — sonst null. */
    fun validPath(rel: String): Boolean {
        val m = PATH.matchEntire(rel) ?: return false
        val id = m.groupValues[5]
        return m.groupValues[3] == id.substring(0, 1) && m.groupValues[4] == id.substring(1, 2)
    }

    fun get(rel: String): Result {
        if (!validPath(rel)) return Result.NotFound
        val file = File(dir, rel)
        if (file.isFile) {
            file.setLastModified(System.currentTimeMillis())
            return Result.Hit(file)
        }
        val lock = inflight.computeIfAbsent(rel) { Any() }
        try {
            synchronized(lock) {
                if (file.isFile) return Result.Hit(file)
                return download(rel, file)
            }
        } finally {
            inflight.remove(rel, lock)
        }
    }

    private fun download(rel: String, file: File): Result {
        upstream.acquire()
        var conn: HttpURLConnection? = null
        try {
            conn = URL("https://cards.scryfall.io/$rel").openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Accept", "image/*")
            val code = conn.responseCode
            if (code == 404 || code == 403) return Result.NotFound
            if (code != 200) return Result.Offline
            file.parentFile?.mkdirs()
            val part = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.part")
            conn.inputStream.use { input -> part.outputStream().use { input.copyTo(it) } }
            if (!part.renameTo(file)) {
                part.delete()
                if (!file.isFile) return Result.Offline
            }
            if (writes.incrementAndGet() % TRIM_EVERY == 0) trimmer.execute { trim() }
            return Result.Hit(file)
        } catch (e: UnknownHostException) {
            return Result.Offline
        } catch (e: SocketTimeoutException) {
            return Result.Offline
        } catch (e: IOException) {
            return Result.Offline
        } finally {
            conn?.disconnect()
            upstream.release()
        }
    }

    /** Größe und Anzahl der aufgehobenen Bilder. */
    fun stats(): Pair<Long, Int> {
        var bytes = 0L
        var count = 0
        dir.walkTopDown().filter { it.isFile && !it.name.endsWith(".part") }.forEach {
            bytes += it.length()
            count++
        }
        return bytes to count
    }

    fun clear() {
        dir.deleteRecursively()
    }

    /** Über dem Limit: die am längsten nicht gebrauchten löschen, bis 80 % frei sind. */
    fun trim() {
        val files = dir.walkTopDown().filter { it.isFile }.toList()
        var total = files.sumOf { it.length() }
        if (total <= MAX_BYTES) return
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= MAX_BYTES * 8 / 10) break
            val len = f.length()
            if (f.delete()) total -= len
        }
    }

    fun shutdown() {
        trimmer.shutdownNow()
    }

    companion object {
        const val MAX_BYTES = 300L * 1024 * 1024
        const val MAX_PARALLEL = 4
        const val TRIM_EVERY = 25
        private val PATH = Regex("^(small|normal|large|png|art_crop|border_crop)/(front|back)/([0-9a-f])/([0-9a-f])/([0-9a-f-]{36})\\.(jpg|png)$")
    }
}
