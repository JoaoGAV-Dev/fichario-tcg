package expo.modules.cardvision

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.CornerPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** Desenha o contorno da carta por cima da câmera: amarelo procurando, verde quando reconheceu. */
class OverlayView(context: Context) : View(context) {
  private val density = context.resources.displayMetrics.density
  private var pts: FloatArray? = null
  private var missing = 0
  private var recognized = false

  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 3.5f * density
    strokeJoin = Paint.Join.ROUND
    pathEffect = CornerPathEffect(14f * density)
  }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    pathEffect = CornerPathEffect(14f * density)
  }
  private val guide = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 3f * density
    strokeCap = Paint.Cap.ROUND
    color = Color.argb(150, 255, 255, 255)
  }
  private val path = Path()

  /** [q]: 8 números (x,y dos 4 cantos) em pixels da view, ou null quando não há carta. */
  fun update(q: FloatArray?, isRecognized: Boolean) {
    if (q == null) {
      missing++
      if (missing > 3) pts = null
    } else {
      missing = 0
      val cur = pts
      pts = if (cur == null) q else FloatArray(8) { cur[it] + (q[it] - cur[it]) * 0.6f }
    }
    recognized = isRecognized
    invalidate()
  }

  fun clear() {
    pts = null
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val p = pts
    if (p == null) {
      drawGuide(canvas)
      return
    }
    path.reset()
    path.moveTo(p[0], p[1])
    path.lineTo(p[2], p[3])
    path.lineTo(p[4], p[5])
    path.lineTo(p[6], p[7])
    path.close()
    val c = if (recognized) Color.rgb(34, 197, 94) else Color.rgb(250, 204, 21)
    fill.color = Color.argb(if (recognized) 46 else 18, Color.red(c), Color.green(c), Color.blue(c))
    stroke.color = c
    canvas.drawPath(path, fill)
    canvas.drawPath(path, stroke)
  }

  /** Cantos de uma moldura central (onde mirar a carta). */
  private fun drawGuide(canvas: Canvas) {
    val vw = width.toFloat()
    val vh = height.toFloat()
    if (vw <= 0 || vh <= 0) return
    var w = 0.78f * vw
    var h = w * 88f / 63f
    if (h > 0.9f * vh) {
      h = 0.9f * vh; w = h * 63f / 88f
    }
    val x0 = (vw - w) / 2
    val y0 = (vh - h) / 2
    val x1 = x0 + w
    val y1 = y0 + h
    val l = 28f * density
    canvas.drawLine(x0, y0, x0 + l, y0, guide); canvas.drawLine(x0, y0, x0, y0 + l, guide)
    canvas.drawLine(x1, y0, x1 - l, y0, guide); canvas.drawLine(x1, y0, x1, y0 + l, guide)
    canvas.drawLine(x0, y1, x0 + l, y1, guide); canvas.drawLine(x0, y1, x0, y1 - l, guide)
    canvas.drawLine(x1, y1, x1 - l, y1, guide); canvas.drawLine(x1, y1, x1, y1 - l, guide)
  }
}
