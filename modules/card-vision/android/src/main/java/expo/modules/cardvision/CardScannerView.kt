package expo.modules.cardvision

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Rational
import android.util.Size
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.ViewPort
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.Point
import org.opencv.core.Rect
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Câmera com reconhecimento contínuo: acha a borda da carta quadro a quadro, desenha o contorno
 * e, quando reconhece a carta pela imagem, avisa o JS (onCard) uma vez por carta.
 */
@SuppressLint("ViewConstructor")
class CardScannerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCard by EventDispatcher()
  private val onTrack by EventDispatcher()
  private val onCameraReady by EventDispatcher()
  private val onCameraError by EventDispatcher()

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private val overlay = OverlayView(context)
  private val main = Handler(Looper.getMainLooper())
  private var executor: ExecutorService = Executors.newSingleThreadExecutor()

  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var bound = false
  private var binding = false

  var active = false
    set(v) {
      field = v; updateBinding()
    }
  @Volatile var paused = false
  var zoom = 1f
    set(v) {
      field = v; applyZoom()
    }
  var torch = false
    set(v) {
      field = v; camera?.cameraControl?.enableTorch(v)
    }
  @Volatile var minScore = 0.80f
  @Volatile var strongScore = 0.90f

  // ---- estado do reconhecimento (só na thread de análise)
  private class Emitted(val ids: Set<String>)
  private var lastEmitted: Emitted? = null
  private val history = ArrayDeque<List<Match>>()
  private var absent = 0
  private var lastRecognize = 0L
  private var recognizedUntil = 0L
  private var lastState = ""
  private var rowBuf: ByteArray? = null
  private var full: Mat? = null

  init {
    previewView.setOnHierarchyChangeListener(object : OnHierarchyChangeListener {
      override fun onChildViewRemoved(parent: View?, child: View?) = Unit
      override fun onChildViewAdded(parent: View?, child: View?) {
        parent?.measure(
          MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY)
        )
        parent?.layout(0, 0, parent.measuredWidth, parent.measuredHeight)
      }
    })
    addView(previewView, ViewGroup.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(overlay, ViewGroup.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    measureChild(overlay, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(
      ViewGroup.resolveSize(previewView.measuredWidth, widthMeasureSpec),
      ViewGroup.resolveSize(previewView.measuredHeight, heightMeasureSpec)
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val w = right - left
    val h = bottom - top
    previewView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    previewView.layout(0, 0, w, h)
    overlay.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    overlay.layout(0, 0, w, h)
    if (active && !bound && w > 0 && h > 0) main.post { updateBinding() }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    updateBinding()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    unbind()
  }

  private fun updateBinding() {
    if (active && isAttachedToWindow && width > 0 && height > 0) bind() else unbind()
  }

  private fun bind() {
    if (bound || binding) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      onCameraError(mapOf("message" to "Tela indisponível para a câmera"))
      return
    }
    binding = true
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      binding = false
      try {
        val p = future.get()
        provider = p
        if (!active || !isAttachedToWindow) return@addListener
        val aspect = AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY
        val preview = Preview.Builder()
          .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(aspect).build())
          .build()
        preview.surfaceProvider = previewView.surfaceProvider
        val analysis = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setAspectRatioStrategy(aspect)
              .setResolutionStrategy(
                ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)
              )
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .build()
        if (executor.isShutdown) executor = Executors.newSingleThreadExecutor()
        analysis.setAnalyzer(executor) { img -> analyze(img) }
        // mesma área visível na tela e na análise: o contorno cai exatamente sobre a carta
        val vp = previewView.viewPort
          ?: ViewPort.Builder(Rational(width, height), display?.rotation ?: Surface.ROTATION_0).build()
        val group = UseCaseGroup.Builder().setViewPort(vp).addUseCase(preview).addUseCase(analysis).build()
        p.unbindAll()
        camera = p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, group)
        bound = true
        applyZoom()
        camera?.cameraControl?.enableTorch(torch)
        onCameraReady(mapOf("index" to CardIndex.ready))
      } catch (e: Throwable) {
        bound = false
        Log.e(TAG, "falha ao abrir a câmera", e)
        onCameraError(mapOf("message" to (e.message ?: e.javaClass.simpleName)))
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun unbind() {
    if (!bound) return
    bound = false
    try {
      provider?.unbindAll()
    } catch (e: Throwable) {
      Log.w(TAG, "unbind", e)
    }
    camera = null
    overlay.clear()
  }

  fun release() {
    unbind()
    executor.shutdown()
  }

  private fun applyZoom() {
    val c = camera ?: return
    val st = c.cameraInfo.zoomState.value
    val lo = st?.minZoomRatio ?: 1f
    val hi = st?.maxZoomRatio ?: 1f
    c.cameraControl.setZoomRatio(zoom.coerceIn(lo, hi))
  }

  // ------------------------------------------------------------ análise (thread própria)

  private fun toMat(image: ImageProxy): Mat {
    val w = image.width
    val h = image.height
    val plane = image.planes[0]
    val bb = plane.buffer
    val rs = plane.rowStride
    val need = w * h * 4
    var buf = rowBuf
    if (buf == null || buf.size != need) {
      buf = ByteArray(need); rowBuf = buf
    }
    bb.rewind()
    if (rs == w * 4) {
      bb.get(buf, 0, need)
    } else {
      for (y in 0 until h) {
        bb.position(y * rs)
        bb.get(buf, y * w * 4, w * 4)
      }
    }
    var f = full
    if (f == null || f.rows() != h || f.cols() != w) {
      f?.release()
      f = Mat(h, w, CvType.CV_8UC4); full = f
    }
    f.put(0, 0, buf)
    val cr = image.cropRect
    val roi = if (cr.width() in 1 until w || cr.height() in 1 until h) {
      f.submat(Rect(cr.left, cr.top, cr.width(), cr.height()))
    } else f
    val out = Mat()
    when (image.imageInfo.rotationDegrees) {
      90 -> Core.rotate(roi, out, Core.ROTATE_90_CLOCKWISE)
      180 -> Core.rotate(roi, out, Core.ROTATE_180)
      270 -> Core.rotate(roi, out, Core.ROTATE_90_COUNTERCLOCKWISE)
      else -> roi.copyTo(out)
    }
    if (roi !== f) roi.release()
    return out
  }

  private fun analyze(image: ImageProxy) {
    try {
      if (!CardDetector.ensureLoaded()) return
      val frame = toMat(image)
      val fw = frame.cols()
      val fh = frame.rows()
      val quads = CardDetector.candidates(frame, 3)
      val now = SystemClock.elapsedRealtime()
      var result: FrameMatch? = null
      val interval = if (lastEmitted != null) 300L else 0L
      if (!paused && CardIndex.ready && now - lastRecognize >= interval) {
        result = CardRecognizer.recognize(frame, quads, quads.isEmpty(), 2, minScore)
        lastRecognize = now
      }
      frame.release()
      handle(quads, result, fw, fh, now)
    } catch (e: Throwable) {
      Log.e(TAG, "análise", e)
    } finally {
      image.close()
    }
  }

  private fun handle(quads: List<Array<Point>>, result: FrameMatch?, fw: Int, fh: Int, now: Long) {
    val good = result != null && result.top.score >= minScore
    val shown: Array<Point>? = if (good) result!!.quad else quads.firstOrNull()
    val present = quads.isNotEmpty() || (good && result!!.guide)
    if (present) absent = 0 else absent++
    if (absent >= 12) {
      // a carta saiu da câmera: a próxima (mesmo que igual) conta de novo
      lastEmitted = null
      history.clear()
    }
    if (result != null) {
      history.addLast(result.matches.take(3))
      while (history.size > 3) history.removeFirst()
      val top = result.top
      val prev = if (history.size >= 2) history[history.size - 2] else null
      val agrees = prev != null && prev.any { it.id == top.id }
      // com uma carta já reconhecida na frente, trocar exige 2 quadros seguidos (evita somar a mesma carta de novo)
      val confirmed = if (lastEmitted != null) top.score >= minScore && agrees
      else top.score >= strongScore || (top.score >= minScore && agrees)
      if (confirmed) {
        val le = lastEmitted
        if (le == null || !le.ids.contains(top.id)) {
          val near = result.matches.filter { it.score >= top.score - 0.05f }.map { it.id }.toSet()
          lastEmitted = Emitted(near + top.id)
          emitCard(result)
        } else {
          lastEmitted = Emitted(le.ids + result.matches.filter { it.score >= top.score - 0.03f }.map { it.id })
        }
        recognizedUntil = now + 900
      }
    }
    val recognized = now < recognizedUntil && (shown != null)
    val state = when {
      recognized -> "recognized"
      shown != null -> "tracking"
      else -> "searching"
    }
    val vw = width.toFloat()
    val vh = height.toFloat()
    val pts = shown?.let { q ->
      val sx = vw / fw
      val sy = vh / fh
      FloatArray(8) { i -> if (i % 2 == 0) (q[i / 2].x * sx).toFloat() else (q[i / 2].y * sy).toFloat() }
    }
    main.post {
      overlay.update(pts, recognized)
      if (state != lastState) {
        lastState = state
        onTrack(mapOf("state" to state))
      }
    }
  }

  private fun emitCard(r: FrameMatch) {
    val payload = mapOf(
      "id" to r.top.id,
      "score" to r.top.score.toDouble(),
      "guide" to r.guide,
      "matches" to r.matches.map { mapOf("id" to it.id, "score" to it.score.toDouble()) }
    )
    main.post { onCard(payload) }
  }

  companion object {
    private const val TAG = "CardVision"
  }
}
