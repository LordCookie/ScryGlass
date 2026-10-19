package com.lordcookie.scryglass

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.os.SystemClock
import android.util.Base64
import android.util.Size
import android.view.View
import android.view.ViewGroup
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Native Scanner-Kamera: CameraX-Vorschau HINTER der (dann transparenten) WebView,
 * Bildauswertung direkt auf dem Gerät. Pro Analyse-Bild:
 *   Kartenausschnitt (Reticle) → Schärfeprüfung (Laplace-Varianz, wie domain/focus.ts)
 *   → Texterkennung mit ML Kit (gebündelt, offline) → Event „frame" an JS mit den
 *   Textzeilen (Position relativ zur Karte) + kleinem JPEG des Ausschnitts für den
 *   Bild-Hash (der bleibt bit-identisch in JS/Pipeline).
 * Abgleich, Fusion, Korb & Verlauf bleiben in JS. Im Browser gibt es dieses Plugin
 * nicht — dort läuft weiter getUserMedia + Tesseract.
 */
@CapacitorPlugin(
    name = "ScryCamera",
    permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")]
)
class ScryCameraPlugin : Plugin() {

    private var previewView: PreviewView? = null
    private var camera: Camera? = null
    private var provider: ProcessCameraProvider? = null
    private var analysisExecutor: ExecutorService? = null
    private var recognizer: TextRecognizer? = null
    private var layoutListener: View.OnLayoutChangeListener? = null
    // Use-Cases merken: bei Drehung (Activity wird NICHT neu erzeugt, configChanges)
    // muss ihnen die neue Displaylage mitgeteilt werden — sonst liegt das Analysebild quer.
    private var previewUseCase: Preview? = null
    private var analysisUseCase: ImageAnalysis? = null

    // Gemeinsamer ViewPort (PLAN.md § 6.2, Schritt 2): Vorschau und Analyse teilen
    // garantiert denselben sichtbaren Ausschnitt; das Analysebild wird auf
    // `ImageProxy.cropRect` zugeschnitten und entspricht dann 1:1 der PreviewView.
    // Fallback (PreviewView noch nicht ausgelegt): eigene FILL_CENTER-Rechnung.
    @Volatile private var useViewPort = false
    private var boundRotation = -1
    private var rebindPending = false
    // Licht/Zoom merken — ein Neu-Binden (Drehung) setzt sie sonst zurück.
    private var torchOn = false
    private var zoomRatio = 1f

    // Reticle normiert auf die WebView (0..1) — von JS gesetzt.
    @Volatile private var retL = 0.1f
    @Volatile private var retT = 0.2f
    @Volatile private var retW = 0.8f
    @Volatile private var retH = 0.6f

    // Geometrie (auf dem Main-Thread gemessen): PreviewView-Größe + WebView-Lage darin.
    @Volatile private var viewW = 0
    @Volatile private var viewH = 0
    @Volatile private var wvOffX = 0f
    @Volatile private var wvOffY = 0f
    @Volatile private var wvW = 0f
    @Volatile private var wvH = 0f

    @Volatile private var analyzing = false
    @Volatile private var busy = false
    @Volatile private var lastRun = 0L
    /** „card" = Texterkennung + Hash-Ausschnitt; „qr" = nur Ausschnitt fürs QR-Pairing (jsQR in JS). */
    @Volatile private var mode = "card"

    @PluginMethod
    fun start(call: PluginCall) {
        readReticle(call)
        mode = call.getString("mode") ?: "card"
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermsCallback")
            return
        }
        startCamera(call)
    }

    @PermissionCallback
    private fun cameraPermsCallback(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) startCamera(call)
        else call.reject("Kamerazugriff verweigert.")
    }

    private fun startCamera(call: PluginCall) {
        activity.runOnUiThread {
            try {
                teardown()
                val webView = bridge.webView
                val parent = webView.parent as ViewGroup
                val pv = PreviewView(context).apply {
                    // TextureView (COMPATIBLE) mischt sich sauber hinter die transparente WebView.
                    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                }
                parent.addView(
                    pv,
                    0,
                    ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                )
                val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateGeometry() }
                pv.addOnLayoutChangeListener(listener)
                webView.addOnLayoutChangeListener(listener)
                layoutListener = listener
                previewView = pv
                webView.setBackgroundColor(Color.TRANSPARENT)
                pv.post { updateGeometry() }

                val executor = Executors.newSingleThreadExecutor()
                analysisExecutor = executor
                recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

                val future = ProcessCameraProvider.getInstance(context)
                future.addListener({
                    try {
                        val prov = future.get()
                        provider = prov
                        // 4:3 = im Hochformat möglichst viel Höhe (Karten sind hochkant).
                        val selector = ResolutionSelector.Builder()
                            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                            .setResolutionStrategy(
                                // Eher kleiner als größer: ein 12-MP-Analysebild wäre viel zu langsam.
                                ResolutionStrategy(
                                    Size(1920, 1440),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                                ),
                            )
                            .build()
                        val preview = Preview.Builder().setResolutionSelector(selector).build()
                        preview.setSurfaceProvider(pv.surfaceProvider)
                        val analysis = ImageAnalysis.Builder()
                            .setResolutionSelector(selector)
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                            .build()
                        analysis.setAnalyzer(executor) { proxy -> analyze(proxy) }
                        previewUseCase = preview
                        analysisUseCase = analysis
                        updateGeometry()
                        val cam = bindUseCases(prov, pv)
                        analyzing = true

                        val ret = JSObject()
                        ret.put("torch", cam.cameraInfo.hasFlashUnit())
                        cam.cameraInfo.zoomState.value?.let {
                            ret.put("zoomMin", it.minZoomRatio.toDouble())
                            ret.put("zoomMax", it.maxZoomRatio.toDouble())
                        }
                        call.resolve(ret)
                    } catch (e: Exception) {
                        teardown()
                        call.reject("Kamera-Start fehlgeschlagen: ${e.message}")
                    }
                }, ContextCompat.getMainExecutor(context))
            } catch (e: Exception) {
                teardown()
                call.reject("Kamera-Start fehlgeschlagen: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity.runOnUiThread {
            teardown()
            call.resolve()
        }
    }

    /** Zwischen Karten-Scan und QR-Pairing umschalten (Kamera läuft weiter). */
    @PluginMethod
    fun setMode(call: PluginCall) {
        mode = call.getString("mode") ?: "card"
        call.resolve()
    }

    /** Neue Lage des Scan-Rahmens (normiert auf die WebView). */
    @PluginMethod
    fun setReticle(call: PluginCall) {
        readReticle(call)
        call.resolve()
    }

    /** Tap-to-Focus: Punkt normiert auf die WebView → Fokus + Belichtung dorthin. */
    @PluginMethod
    fun focus(call: PluginCall) {
        val x = call.getFloat("x") ?: 0.5f
        val y = call.getFloat("y") ?: 0.5f
        activity.runOnUiThread {
            val pv = previewView
            val cam = camera
            if (pv == null || cam == null) {
                call.resolve()
                return@runOnUiThread
            }
            val point = pv.meteringPointFactory.createPoint(wvOffX + x * wvW, wvOffY + y * wvH)
            val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(4, TimeUnit.SECONDS)
                .build()
            cam.cameraControl.startFocusAndMetering(action)
            call.resolve()
        }
    }

    @PluginMethod
    fun setTorch(call: PluginCall) {
        val on = call.getBoolean("on") ?: false
        activity.runOnUiThread {
            torchOn = on
            camera?.cameraControl?.enableTorch(on)
            call.resolve()
        }
    }

    @PluginMethod
    fun setZoom(call: PluginCall) {
        val ratio = call.getFloat("ratio") ?: 1f
        activity.runOnUiThread {
            zoomRatio = ratio
            camera?.cameraControl?.setZoomRatio(ratio)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        activity.runOnUiThread { teardown() }
        super.handleOnDestroy()
    }

    // --- intern -------------------------------------------------------------

    private fun readReticle(call: PluginCall) {
        retL = (call.getFloat("left") ?: retL).coerceIn(0f, 1f)
        retT = (call.getFloat("top") ?: retT).coerceIn(0f, 1f)
        retW = (call.getFloat("width") ?: retW).coerceIn(0.01f, 1f)
        retH = (call.getFloat("height") ?: retH).coerceIn(0.01f, 1f)
    }

    /** Main-Thread: Maße der PreviewView und Lage der WebView darin merken. */
    private fun updateGeometry() {
        val pv = previewView ?: return
        val wv = bridge.webView
        val a = IntArray(2)
        val b = IntArray(2)
        wv.getLocationOnScreen(a)
        pv.getLocationOnScreen(b)
        wvOffX = (a[0] - b[0]).toFloat()
        wvOffY = (a[1] - b[1]).toFloat()
        wvW = wv.width.toFloat()
        wvH = wv.height.toFloat()
        viewW = pv.width
        viewH = pv.height
        // Hoch-/Querformat: Analysebild „aufrecht" relativ zum Display halten.
        val rot = pv.display?.rotation
        if (rot != null) {
            previewUseCase?.targetRotation = rot
            analysisUseCase?.targetRotation = rot
        }
        // Neu binden, wenn der ViewPort jetzt erst verfügbar ist oder sich die Drehung
        // geändert hat (der ViewPort hängt an Seitenverhältnis + Drehung).
        val prov = provider ?: return
        if (camera == null || rebindPending) return
        val needViewPort = !useViewPort && pv.width > 0 && pv.viewPort != null
        val rotated = useViewPort && rot != null && rot != boundRotation
        if (needViewPort || rotated) {
            rebindPending = true
            pv.post {
                rebindPending = false
                if (provider === prov && previewView === pv) {
                    try {
                        bindUseCases(prov, pv)
                    } catch (_: Exception) {
                    }
                }
            }
        }
    }

    /** Main-Thread: Vorschau + Analyse binden — mit gemeinsamem ViewPort, wenn möglich. */
    private fun bindUseCases(prov: ProcessCameraProvider, pv: PreviewView): Camera {
        val preview = previewUseCase ?: throw IllegalStateException("keine Vorschau")
        val analysis = analysisUseCase ?: throw IllegalStateException("keine Analyse")
        prov.unbindAll()
        val vp = if (pv.width > 0) pv.viewPort else null
        val cam = if (vp != null) {
            val group = UseCaseGroup.Builder()
                .setViewPort(vp)
                .addUseCase(preview)
                .addUseCase(analysis)
                .build()
            prov.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, group)
        } else {
            prov.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }
        useViewPort = vp != null
        boundRotation = pv.display?.rotation ?: -1
        camera = cam
        if (torchOn) cam.cameraControl.enableTorch(true)
        if (zoomRatio != 1f) cam.cameraControl.setZoomRatio(zoomRatio)
        return cam
    }

    private fun teardown() {
        analyzing = false
        try {
            provider?.unbindAll()
        } catch (_: Exception) {
        }
        provider = null
        camera = null
        previewUseCase = null
        analysisUseCase = null
        useViewPort = false
        boundRotation = -1
        rebindPending = false
        torchOn = false
        zoomRatio = 1f
        val listener = layoutListener
        previewView?.let { pv ->
            if (listener != null) pv.removeOnLayoutChangeListener(listener)
            (pv.parent as? ViewGroup)?.removeView(pv)
        }
        if (listener != null) bridge.webView.removeOnLayoutChangeListener(listener)
        layoutListener = null
        previewView = null
        analysisExecutor?.shutdown()
        analysisExecutor = null
        recognizer?.close()
        recognizer = null
        busy = false
        // Seite zeichnet ihren eigenen Hintergrund; WebView wieder deckend machen.
        bridge.webView.setBackgroundColor(Color.WHITE)
    }

    /** Analyse-Thread: höchstens alle MIN_INTERVAL_MS ein Bild, nie parallel. */
    private fun analyze(proxy: ImageProxy) {
        val now = SystemClock.elapsedRealtime()
        if (!analyzing || busy || now - lastRun < MIN_INTERVAL_MS || viewW == 0 || viewH == 0 || wvW == 0f) {
            proxy.close()
            return
        }
        busy = true
        lastRun = now

        val mappedViaViewPort = useViewPort
        val upright: Bitmap? = try {
            val full = proxy.toBitmap()
            // Mit ViewPort: auf den sichtbaren Ausschnitt zuschneiden (falls toBitmap das
            // nicht schon getan hat) — danach entspricht das Bild exakt der PreviewView.
            val cr = proxy.cropRect
            val raw = if (mappedViaViewPort && (cr.width() != full.width || cr.height() != full.height) &&
                cr.left >= 0 && cr.top >= 0 && cr.right <= full.width && cr.bottom <= full.height
            ) {
                val c = Bitmap.createBitmap(full, cr.left, cr.top, cr.width(), cr.height())
                if (c !== full) full.recycle()
                c
            } else {
                full
            }
            val rot = proxy.imageInfo.rotationDegrees
            if (rot != 0) {
                val m = Matrix()
                m.postRotate(rot.toFloat())
                val rotated = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
                if (rotated !== raw) raw.recycle()
                rotated
            } else {
                raw
            }
        } catch (_: Exception) {
            null
        } finally {
            proxy.close()
        }

        // Ab hier darf nichts „busy" hängen lassen — sonst käme nie wieder ein Bild.
        var crop: Bitmap? = null
        try {
            crop = upright?.let { cropReticle(it, mappedViaViewPort) }
            if (upright != null && crop !== upright) upright.recycle() // ~4×/s große Bitmaps sofort freigeben
            if (crop == null) {
                busy = false
                return
            }

            // QR-Pairing: kein Schärfe-Gate, keine Texterkennung — nur den Ausschnitt
            // in brauchbarer Auflösung an JS (jsQR dekodiert dort).
            if (mode == "qr") {
                val qr = JSObject()
                qr.put("blurry", false)
                qr.put("sharpness", 0.0)
                qr.put("qr", qrJpeg(crop))
                emit(qr)
                crop.recycle()
                busy = false
                return
            }

            val sharp = sharpness(crop)
            if (sharp < SHARP_MIN) {
                val blur = JSObject()
                blur.put("blurry", true)
                blur.put("sharpness", sharp)
                emit(blur)
                crop.recycle()
                busy = false
                return
            }

            val rec = recognizer
            if (rec == null) {
                crop.recycle()
                busy = false
                return
            }
            val jpeg = smallJpeg(crop)
            val w = crop.width
            val h = crop.height
            val bmp = crop
            rec.process(InputImage.fromBitmap(bmp, 0))
                .addOnSuccessListener { text -> emit(framePayload(text, w, h, sharp, jpeg, mappedViaViewPort)) }
                .addOnFailureListener { _ -> emit(framePayload(null, w, h, sharp, jpeg, mappedViaViewPort)) }
                .addOnCompleteListener {
                    bmp.recycle()
                    busy = false
                }
        } catch (_: Throwable) {
            crop?.recycle()
            busy = false
        }
    }

    /**
     * Reticle (WebView-normiert) → Rechteck im aufrechten Analysebild.
     * ViewPort: Bild = sichtbare PreviewView → lineare Abbildung. Sonst eigene
     * FILL_CENTER-Rechnung (stimmt nur, wenn Vorschau und Analyse denselben Bildwinkel haben).
     */
    private fun cropReticle(bmp: Bitmap, viaViewPort: Boolean): Bitmap? {
        val vw = viewW.toFloat()
        val vh = viewH.toFloat()
        val rx = wvOffX + retL * wvW
        val ry = wvOffY + retT * wvH
        val rw = retW * wvW
        val rh = retH * wvH
        val sx: Float
        val sy: Float
        val offX: Float
        val offY: Float
        if (viaViewPort) {
            sx = vw / bmp.width
            sy = vh / bmp.height
            offX = 0f
            offY = 0f
        } else {
            val scale = max(vw / bmp.width, vh / bmp.height)
            sx = scale
            sy = scale
            offX = (bmp.width * scale - vw) / 2f
            offY = (bmp.height * scale - vh) / 2f
        }
        val x = ((rx + offX) / sx).roundToInt().coerceIn(0, bmp.width - 1)
        val y = ((ry + offY) / sy).roundToInt().coerceIn(0, bmp.height - 1)
        val w = (rw / sx).roundToInt().coerceIn(1, bmp.width - x)
        val h = (rh / sy).roundToInt().coerceIn(1, bmp.height - y)
        return try {
            Bitmap.createBitmap(bmp, x, y, w, h)
        } catch (_: Exception) {
            null
        }
    }

    /** Laplace-Varianz auf 128 px Breite — dieselbe Formel wie domain/focus.ts. */
    private fun sharpness(crop: Bitmap): Double {
        val w = 128
        val h = max(3, (crop.height * w.toFloat() / crop.width).roundToInt())
        val small = Bitmap.createScaledBitmap(crop, w, h, true)
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        if (small !== crop) small.recycle()
        val g = IntArray(w * h) { i ->
            val c = px[i]
            (0.299 * ((c shr 16) and 0xff) + 0.587 * ((c shr 8) and 0xff) + 0.114 * (c and 0xff)).toInt()
        }
        var sum = 0.0
        var sumSq = 0.0
        var n = 0
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                val lap = (4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]).toDouble()
                sum += lap
                sumSq += lap * lap
                n++
            }
        }
        if (n == 0) return 0.0
        val mean = sum / n
        return sumSq / n - mean * mean
    }

    /** Kleiner Ausschnitt fürs Bild-Hashing in JS (gleiche Größe wie der Web-Pfad). */
    private fun smallJpeg(crop: Bitmap): String {
        val small = Bitmap.createScaledBitmap(crop, 146, 204, true)
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 92, out)
        if (small !== crop) small.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    /** QR-Ausschnitt: längste Seite max. 640 px — genug für jsQR, klein genug für die Brücke. */
    private fun qrJpeg(crop: Bitmap): String {
        val scale = minOf(1f, 640f / max(crop.width, crop.height))
        val w = max(1, (crop.width * scale).roundToInt())
        val h = max(1, (crop.height * scale).roundToInt())
        val small = if (scale < 1f) Bitmap.createScaledBitmap(crop, w, h, true) else crop
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 85, out)
        if (small !== crop) small.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun framePayload(text: Text?, w: Int, h: Int, sharp: Double, jpeg: String, viaViewPort: Boolean): JSObject {
        val lines = JSArray()
        if (text != null) {
            for (block in text.textBlocks) {
                for (line in block.lines) {
                    val bb = line.boundingBox ?: continue
                    val o = JSObject()
                    o.put("text", line.text)
                    o.put("l", bb.left.toDouble() / w)
                    o.put("t", bb.top.toDouble() / h)
                    o.put("r", bb.right.toDouble() / w)
                    o.put("b", bb.bottom.toDouble() / h)
                    o.put("conf", line.confidence.toDouble())
                    lines.put(o)
                }
            }
        }
        val ret = JSObject()
        ret.put("blurry", false)
        ret.put("sharpness", sharp)
        ret.put("lines", lines)
        ret.put("crop", jpeg)
        // Welche Abbildung Rahmen → Analysebild galt (Diagnose, Scan-Protokoll).
        ret.put("mapping", if (viaViewPort) "viewport" else "fill")
        return ret
    }

    private fun emit(data: JSObject) {
        if (!analyzing) return
        activity.runOnUiThread { notifyListeners("frame", data) }
    }

    companion object {
        /** ~4 Auswertungen pro Sekunde reichen und schonen den Akku. */
        private const val MIN_INTERVAL_MS = 250L
        /** Wie SHARP_MIN im Web-Scanner (Laplace-Varianz, 128 px breit). */
        private const val SHARP_MIN = 30.0
    }
}
