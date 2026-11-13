package com.lordcookie.scryglass

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar

/**
 * Täglicher Update-Blick (PLAN.md M23): gegen 12 Uhr bei GitHub nachsehen, ob es eine neue
 * App-Version oder einen neuen Katalog gibt, und per Benachrichtigung Bescheid geben — auch
 * wenn die App zu ist. Läuft über den eingebauten JobScheduler (keine Bibliothek). Prüft
 * dasselbe wie die App (src/data/updates.ts); jede Version wird nur einmal gemeldet.
 */
object UpdateNotifier {
    const val JOB_ID = 4712
    const val EXTRA_OPEN_UPDATES = "scryglass.openUpdates"
    private const val CHANNEL = "updates"
    private const val PREFS = "scryglass_updates"
    private const val REPO = "LordCookie/ScryGlass"
    /** Fenster: ab 12 Uhr, spätestens 14 Uhr (Android bündelt Hintergrundarbeit). */
    private const val HOUR = 12
    private const val WINDOW_MS = 2L * 60 * 60 * 1000

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun configure(ctx: Context, enabled: Boolean, catalogVersion: String?) {
        val e = prefs(ctx).edit().putBoolean("enabled", enabled)
        if (!catalogVersion.isNullOrEmpty()) e.putString("catalogVersion", catalogVersion)
        e.apply()
        if (enabled) schedule(ctx) else cancel(ctx)
    }

    fun enabled(ctx: Context): Boolean = prefs(ctx).getBoolean("enabled", false)

    /** Nächsten Lauf planen: heute 12 Uhr, wenn noch nicht vorbei, sonst morgen. */
    fun schedule(ctx: Context) {
        if (!enabled(ctx)) return
        val now = Calendar.getInstance()
        val next = (now.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, HOUR)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (!after(now)) add(Calendar.DAY_OF_MONTH, 1)
        }
        val delay = next.timeInMillis - now.timeInMillis
        val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, UpdateCheckJob::class.java))
            .setMinimumLatency(delay)
            .setOverrideDeadline(delay + WINDOW_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build()
        (ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).schedule(job)
    }

    fun cancel(ctx: Context) {
        (ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler).cancel(JOB_ID)
    }

    // --- Prüfen ---------------------------------------------------------------------

    private fun get(url: String, ua: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 20_000
        c.setRequestProperty("User-Agent", ua)
        c.setRequestProperty("Accept", "application/vnd.github+json, application/json")
        try {
            if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    private fun parse(v: String): List<Int>? {
        val m = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)$").matchEntire(v.trim()) ?: return null
        return m.groupValues.drop(1).map { it.toInt() }
    }

    private fun newer(a: String, b: String): Boolean {
        val x = parse(a) ?: return false
        val y = parse(b) ?: return true
        for (i in 0..2) if (x[i] != y[i]) return x[i] > y[i]
        return false
    }

    /** Höchstes Release `vX.Y.Z` (kein Entwurf/Vorab) mit `ScryGlass-X.Y.Z.apk`. */
    private fun latestApp(json: String): String? {
        var best: String? = null
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val tag = r.optString("tag_name")
            if (parse(tag) == null) continue
            val version = tag.removePrefix("v")
            val assets = r.optJSONArray("assets") ?: continue
            val hasApk = (0 until assets.length()).any { assets.getJSONObject(it).optString("name") == "ScryGlass-$version.apk" }
            if (hasApk && (best == null || newer(version, best))) best = version
        }
        return best
    }

    /** Einmal nachsehen und ggf. benachrichtigen. Fehler (offline …) → still, morgen wieder. */
    fun check(ctx: Context) {
        val installed = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
        } catch (e: Exception) { "" }
        val ua = "ScryGlass/$installed (Android; Update-Check)"
        val p = prefs(ctx)

        val app = try { latestApp(get("https://api.github.com/repos/$REPO/releases?per_page=30", ua)) } catch (e: Exception) { null }
        val catalog = try {
            JSONObject(get("https://github.com/$REPO/releases/download/catalog-latest/version.json", ua)).optString("catalogVersion")
        } catch (e: Exception) { null }

        val newApp = app?.takeIf { newer(it, installed) && it != p.getString("notifiedApp", null) }
        val local = p.getString("catalogVersion", null)
        val newCatalog = catalog?.takeIf { !local.isNullOrEmpty() && it > local && it != p.getString("notifiedCatalog", null) }
        if (newApp == null && newCatalog == null) return
        if (notify(ctx, newApp, newCatalog)) {
            p.edit().apply {
                if (newApp != null) putString("notifiedApp", newApp)
                if (newCatalog != null) putString("notifiedCatalog", newCatalog)
            }.apply()
        }
    }

    private fun catalogDate(v: String): String =
        if (v.length >= 8) "${v.substring(6, 8)}.${v.substring(4, 6)}." else v

    private fun notify(ctx: Context, app: String?, catalog: String?): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Neue App-Version oder neuer Katalog"
                })
            }
        }
        val text = when {
            app != null && catalog != null -> "App $app und Katalog vom ${catalogDate(catalog)} sind bereit."
            app != null -> "Version $app ist bereit."
            else -> "Neuer Katalog vom ${catalogDate(catalog!!)} ist bereit."
        }
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply {
            putExtra(EXTRA_OPEN_UPDATES, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        } ?: return false
        val pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_scryglass)
            .setContentTitle(if (app != null) "ScryGlass: Update verfügbar" else "ScryGlass: Neuer Katalog")
            .setContentText("$text Antippen zum Laden.")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        return try {
            NotificationManagerCompat.from(ctx).notify(JOB_ID, n)
            true
        } catch (e: SecurityException) {
            false
        }
    }
}
