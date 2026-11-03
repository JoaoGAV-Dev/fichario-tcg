package expo.modules.cardvision

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.opencv.android.Utils
import org.opencv.core.Mat
import java.io.File

/**
 * Reconhecimento de cartas pela imagem, no aparelho: câmera com contorno ao vivo (CardScanner)
 * e reconhecimento de uma foto da galeria.
 */
class CardVisionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CardVision")

    Function("isAvailable") { true }

    Function("indexInfo") {
      mapOf("ready" to CardIndex.ready, "count" to CardIndex.count, "version" to CardIndex.version)
    }

    AsyncFunction("loadIndexAsync") { model: String, emb: String, ids: String, dim: Int, version: String ->
      if (!CardDetector.ensureLoaded()) throw CodedException("ERR_OPENCV", "OpenCV não carregou", null)
      CardIndex.load(toFile(model), toFile(emb), toFile(ids), dim, version)
      CardIndex.count
    }

    AsyncFunction("recognizeImageAsync") { uri: String ->
      val ctx = appContext.reactContext ?: throw CodedException("ERR_CONTEXT", "Contexto indisponível", null)
      if (!CardDetector.ensureLoaded()) throw CodedException("ERR_OPENCV", "OpenCV não carregou", null)
      if (!CardIndex.ready) throw CodedException("ERR_INDEX", "Banco de cartas ainda não carregado", null)
      val bmp = loadBitmap(ctx, Uri.parse(uri), 1600)
      val mat = Mat()
      Utils.bitmapToMat(bmp, mat)
      bmp.recycle()
      val t0 = System.currentTimeMillis()
      val quads = CardDetector.candidates(mat, 3)
      val r = CardRecognizer.recognize(mat, quads, true, 3, 0.8f)
      val w = mat.cols()
      val h = mat.rows()
      mat.release()
      if (r == null) {
        mapOf("matches" to emptyList<Any>(), "ms" to (System.currentTimeMillis() - t0).toInt())
      } else {
        mapOf(
          "id" to r.top.id,
          "score" to r.top.score.toDouble(),
          "guide" to r.guide,
          "candidates" to quads.size,
          "ms" to (System.currentTimeMillis() - t0).toInt(),
          "quad" to r.quad.flatMap { listOf(it.x / w, it.y / h) },
          "matches" to r.matches.map { mapOf("id" to it.id, "score" to it.score.toDouble()) }
        )
      }
    }

    View(CardScannerView::class) {
      Events("onCard", "onTrack", "onCameraReady", "onCameraError")

      Prop("active") { view: CardScannerView, v: Boolean -> view.active = v }
      Prop("paused") { view: CardScannerView, v: Boolean -> view.paused = v }
      Prop("zoom") { view: CardScannerView, v: Double -> view.zoom = v.toFloat() }
      Prop("torch") { view: CardScannerView, v: Boolean -> view.torch = v }
      Prop("minScore") { view: CardScannerView, v: Double -> view.minScore = v.toFloat() }
      Prop("strongScore") { view: CardScannerView, v: Double -> view.strongScore = v.toFloat() }

      OnViewDestroys { view: CardScannerView -> view.release() }
    }
  }

  private fun toFile(p: String): File = File(if (p.startsWith("file:")) Uri.parse(p).path!! else p)

  private fun loadBitmap(ctx: Context, uri: Uri, maxSide: Int): Bitmap {
    val open = {
      if (uri.scheme == null || uri.scheme == "file") File(uri.path ?: uri.toString()).inputStream()
      else ctx.contentResolver.openInputStream(uri) ?: throw CodedException("ERR_IMAGE", "Não consegui abrir a imagem", null)
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open().use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    var bmp = open().use { BitmapFactory.decodeStream(it, null, opts) }
      ?: throw CodedException("ERR_IMAGE", "Imagem inválida", null)
    val rot = try {
      open().use { ExifInterface(it).rotationDegrees }
    } catch (e: Exception) {
      0
    }
    if (rot != 0) {
      val m = Matrix().apply { postRotate(rot.toFloat()) }
      val r = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
      if (r !== bmp) bmp.recycle()
      bmp = r
    }
    if (bmp.config != Bitmap.Config.ARGB_8888) {
      val c = bmp.copy(Bitmap.Config.ARGB_8888, false)
      bmp.recycle()
      bmp = c
    }
    return bmp
  }
}
