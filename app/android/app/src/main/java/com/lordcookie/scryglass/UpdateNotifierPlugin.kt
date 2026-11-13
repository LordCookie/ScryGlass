package com.lordcookie.scryglass

import android.Manifest
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Brücke zum täglichen Update-Blick (PLAN.md M23): an/aus, eingespielter Katalogstand,
 * Erlaubnis für Benachrichtigungen (Android 13+) und ob die App über die Benachrichtigung
 * geöffnet wurde.
 */
@CapacitorPlugin(
    name = "UpdateNotifier",
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class UpdateNotifierPlugin : Plugin() {

    @PluginMethod
    fun configure(call: PluginCall) {
        UpdateNotifier.configure(context, call.getBoolean("enabled") ?: false, call.getString("catalogVersion"))
        call.resolve()
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
            return
        }
        requestPermissionForAlias("notifications", call, "permissionResult")
    }

    @PermissionCallback
    private fun permissionResult(call: PluginCall) {
        call.resolve(JSObject().put("granted", getPermissionState("notifications") == PermissionState.GRANTED))
    }

    /** Wurde die App über die Update-Benachrichtigung geöffnet? (nur einmal „ja") */
    @PluginMethod
    fun consumeLaunch(call: PluginCall) {
        val intent = activity?.intent
        val open = intent?.getBooleanExtra(UpdateNotifier.EXTRA_OPEN_UPDATES, false) ?: false
        if (open) intent?.removeExtra(UpdateNotifier.EXTRA_OPEN_UPDATES)
        call.resolve(JSObject().put("openUpdates", open))
    }

    // App läuft schon und wird über die Benachrichtigung nach vorn geholt.
    override fun handleOnNewIntent(intent: android.content.Intent?) {
        super.handleOnNewIntent(intent)
        if (intent?.getBooleanExtra(UpdateNotifier.EXTRA_OPEN_UPDATES, false) == true) {
            intent.removeExtra(UpdateNotifier.EXTRA_OPEN_UPDATES)
            notifyListeners("openUpdates", JSObject())
        }
    }
}
