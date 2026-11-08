package expo.modules.cardvision

import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.opencv.android.Utils
import org.opencv.core.Mat
import org.opencv.core.Point
import org.opencv.imgproc.Imgproc
import java.text.Normalizer
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Reconhecimento de produtos lacrados (ETB, booster, box, blister…). Não há "borda" como numa carta:
 * testa recortes quadrados no centro em 3 tamanhos, ajusta o melhor e compara com o banco de produtos.
 */
object SealedRecognizer {
  private fun square(cx: Double, cy: Double, side: Double): Array<Point> {
    val h = side / 2
    return arrayOf(Point(cx - h, cy - h), Point(cx + h, cy - h), Point(cx + h, cy + h), Point(cx - h, cy + h))
  }

  fun recognize(src: Mat, refineBelow: Float): FrameMatch? {
    if (!SealedIndex.ready) return null
    val w = src.cols().toDouble()
    val h = src.rows().toDouble()
    val m = min(w, h)
    var best: FrameMatch? = null
    for (sc in doubleArrayOf(0.6, 0.8, 0.98)) {
      val q = square(w / 2, h / 2, m * sc)
      val r = embedSearch(src, q)
      if (r.isNotEmpty() && (best == null || r[0].score > best.top.score)) best = FrameMatch(q, true, r)
    }
    val b0 = best ?: return null
    if (b0.top.score < refineBelow) {
      val q = b0.quad
      val cx = (q[0].x + q[2].x) / 2
      val cy = (q[0].y + q[2].y) / 2
      val side = q[1].x - q[0].x
      val tries = listOf(
        square(cx, cy, side * 0.85), square(cx, cy, side * 1.15),
        square(cx - side * 0.08, cy, side), square(cx + side * 0.08, cy, side),
        square(cx, cy - side * 0.08, side), square(cx, cy + side * 0.08, side)
      )
      for (t in tries) {
        val r = embedSearch(src, t)
        if (r.isNotEmpty() && r[0].score > best!!.top.score) best = FrameMatch(t, true, r)
      }
    }
    return best
  }

  private fun embedSearch(src: Mat, q: Array<Point>): List<Match> {
    val crop = CardDetector.warp(src, q, false, SealedIndex.inW, SealedIndex.inH)
    val v = try {
      SealedIndex.embed(crop)
    } finally {
      crop.release()
    }
    return SealedIndex.search(v, 8)
  }

  // ---- idioma da embalagem (português x inglês) pelo texto impresso
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
  private val PT = listOf(
    "estampas ilustradas", "treinador avancado", "colecao", "cartas", "pacote", "contem", "idade", "anos",
    "jogo de cartas", "megaevolucao", "escarlate", "violeta", "booster com", "caixa", "fichario", "lata", "aviso"
  )
  private val EN = listOf(
    "trading card game", "elite trainer", "collection", "contains", "cards", "ages", "warning", "booster pack",
    "mega evolution", "scarlet", "violet", "premium", "includes", "pokemon tcg"
  )

  private fun norm(s: String) =
    Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()

  /** "PT", "EN" ou null (não deu para saber). Roda no recorte do produto no quadro original. */
  fun detectLanguage(src: Mat, q: Array<Point>): String? {
    return try {
      val side = max(1.0, q[1].x - q[0].x)
      val f = min(1.0, 1280.0 / side)
      val outW = max(64, (side * f).roundToInt())
      val crop = CardDetector.warp(src, q, false, outW, outW)
      val bmp = Bitmap.createBitmap(crop.cols(), crop.rows(), Bitmap.Config.ARGB_8888)
      val rgba = Mat()
      Imgproc.cvtColor(crop, rgba, Imgproc.COLOR_RGB2RGBA)
      Utils.matToBitmap(rgba, bmp)
      crop.release(); rgba.release()
      val text = norm(Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)), 3, TimeUnit.SECONDS).text)
      bmp.recycle()
      val pt = PT.count { text.contains(it) }
      val en = EN.count { text.contains(it) }
      when {
        pt == 0 && en == 0 -> null
        pt > en -> "PT"
        en > pt -> "EN"
        else -> null
      }
    } catch (e: Throwable) {
      null
    }
  }
}
