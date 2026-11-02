package com.lordcookie.scryglass

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * App-Update aus der App heraus (PLAN.md M15). Die APK lädt JS über das Filesystem-Plugin
 * in den Cache; hier wird sie GEPRÜFT und dann der Android-Installer geöffnet:
 *   1. SHA-256 = Prüfsumme aus dem Release (`.sha256`) — nichts Kaputtes installieren
 *   2. gleiches Paket, höhere versionCode
 *   3. gleiches Signaturzertifikat wie die installierte App — sonst lehnt Android das
 *      Update ohnehin ab, hier aber mit verständlicher Meldung
 * Fehlercodes (call.reject(…, code)) wertet `data/updates.ts` aus.
 */
@CapacitorPlugin(name = "AppUpdater")
class AppUpdaterPlugin : Plugin() {

    /** Darf die App Pakete installieren? (Android 8+: einmal pro App erlauben.) */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        val ret = JSObject()
        ret.put("allowed", installAllowed())
        ret.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
        call.resolve(ret)
    }

    /** Systemeinstellung „Unbekannte Apps installieren" für ScryGlass öffnen. */
    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
        call.resolve()
    }

    /** APK prüfen und den Installer öffnen. Erwartet `path` (aus downloadFile) und `sha256`. */
    @PluginMethod
    fun install(call: PluginCall) {
        val rawPath = call.getString("path") ?: run { call.reject("path fehlt", "PFAD"); return }
        val expected = call.getString("sha256")?.lowercase()
        Thread {
            try {
                val file = File(if (rawPath.startsWith("file://")) Uri.parse(rawPath).path ?: rawPath else rawPath)
                if (!file.isFile) return@Thread call.reject("Datei nicht gefunden", "PFAD")
                // Content-URIs braucht der Installer erst ab Android 7; davor ginge es nur
                // über eine öffentlich lesbare Datei — dort lieber von Hand installieren.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return@Thread call.reject("Android zu alt", "ALT")

                if (expected != null && sha256(file) != expected) {
                    file.delete()
                    return@Thread call.reject("Prüfsumme stimmt nicht", "PRUEFSUMME")
                }

                val pm = context.packageManager
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    PackageManager.GET_SIGNING_CERTIFICATES
                } else {
                    @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
                }
                val archive = pm.getPackageArchiveInfo(file.absolutePath, flags)
                    ?: return@Thread call.reject("Keine gültige APK", "APK")
                if (archive.packageName != context.packageName) return@Thread call.reject("Falsches Paket", "PAKET")
                val installed = pm.getPackageInfo(context.packageName, flags)
                if (PackageInfoCompat.getLongVersionCode(archive) <= PackageInfoCompat.getLongVersionCode(installed)) {
                    return@Thread call.reject("Nicht neuer als die installierte Version", "NICHT_NEUER")
                }
                // Signatur vergleichen, soweit Android sie für die Datei verrät (bei manchen
                // Versionen fehlt sie für Archive — dann prüft der Installer selbst).
                val mine = certHashes(installed)
                val theirs = certHashes(archive)
                if (mine != null && theirs != null && mine.intersect(theirs).isEmpty()) {
                    return@Thread call.reject("Anders signiert", "SIGNATUR")
                }
                if (!installAllowed()) return@Thread call.reject("Installieren nicht erlaubt", "ERLAUBNIS")

                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                val intent = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Installation fehlgeschlagen", "FEHLER")
            }
        }.start()
    }

    private fun installAllowed(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** SHA-256 der Signaturzertifikate (inkl. früherer bei Schlüsselrotation). */
    private fun certHashes(info: PackageInfo): Set<String>? {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val si = info.signingInfo ?: return null
            if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
        } else {
            @Suppress("DEPRECATION") info.signatures
        }
        if (sigs.isNullOrEmpty()) return null
        return sigs.map { s ->
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }
}
