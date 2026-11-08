package expo.modules.cardvision

import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.opencv.android.Utils
import org.opencv.core.Mat
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Leitura de texto no aparelho (ML Kit): etiqueta de slab, preço do anúncio, idioma da embalagem. */
object TextReader {
  private val client by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  fun read(bmp: Bitmap, timeoutS: Long = 4): String =
    try {
      Tasks.await(client.process(InputImage.fromBitmap(bmp, 0)), timeoutS, TimeUnit.SECONDS).text
    } catch (e: Throwable) {
      ""
    }

  /** Texto de uma região (com aumento quando pequena: o OCR precisa de letras com ~20 px). */
  fun readRegion(src: Mat, r: Rect, minW: Int = 900): String {
    val roi = Mat(src, r)
    val f = if (r.width < minW) min(3.0, minW.toDouble() / r.width) else 1.0
    val m = Mat()
    if (f > 1.0) Imgproc.resize(roi, m, Size(r.width * f, r.height * f), 0.0, 0.0, Imgproc.INTER_CUBIC) else roi.copyTo(m)
    roi.release()
    val rgba = Mat()
    when (m.channels()) {
      4 -> m.copyTo(rgba)
      3 -> Imgproc.cvtColor(m, rgba, Imgproc.COLOR_RGB2RGBA)
      else -> Imgproc.cvtColor(m, rgba, Imgproc.COLOR_GRAY2RGBA)
    }
    m.release()
    val bmp = Bitmap.createBitmap(rgba.cols(), rgba.rows(), Bitmap.Config.ARGB_8888)
    Utils.matToBitmap(rgba, bmp)
    rgba.release()
    return try {
      read(bmp)
    } finally {
      bmp.recycle()
    }
  }

  /** Etiqueta do slab: a faixa logo acima da carta (empresa, nota, número de certificado). */
  fun slabLabel(src: Mat, q: Array<Point>): String {
    return try {
      val minX = q.minOf { it.x }
      val maxX = q.maxOf { it.x }
      val minY = q.minOf { it.y }
      val cw = maxX - minX
      val ch = q.maxOf { it.y } - minY
      val y0 = max(0.0, minY - 0.45 * ch)
      val y1 = max(0.0, minY + 0.02 * ch)
      if (y1 - y0 < 0.1 * ch) return ""
      val x0 = max(0.0, minX - 0.15 * cw)
      val x1 = min(src.cols().toDouble(), maxX + 0.15 * cw)
      val r = Rect(x0.roundToInt(), y0.roundToInt(), (x1 - x0).roundToInt(), (y1 - y0).roundToInt())
      if (r.width < 16 || r.height < 8 || r.x + r.width > src.cols() || r.y + r.height > src.rows()) return ""
      readRegion(src, r)
    } catch (e: Throwable) {
      ""
    }
  }
}
