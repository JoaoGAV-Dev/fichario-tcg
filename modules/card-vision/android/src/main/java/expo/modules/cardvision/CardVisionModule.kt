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
@android.annotation.SuppressLint("DiscouragedApi")
class CardVisionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CardVision")

    Function("isAvailable") { true }

    Function("indexInfo") { kind: String? ->
      val ix = indexOf(kind)
      mapOf("ready" to ix.ready, "count" to ix.count, "version" to ix.version)
    }

    AsyncFunction("loadIndexAsync") { model: String, emb: String, ids: String, dim: Int, version: String, kind: String? ->
      if (!CardDetector.ensureLoaded()) throw CodedException("ERR_OPENCV", "OpenCV não carregou", null)
      val ix = indexOf(kind)
      ix.load(toFile(model), toFile(emb), toFile(ids), dim, version)
      ix.count
    }

    AsyncFunction("recognizeImageAsync") { uri: String, kind: String? ->
      val ctx = appContext.reactContext ?: throw CodedException("ERR_CONTEXT", "Contexto indisponível", null)
      if (!CardDetector.ensureLoaded()) throw CodedException("ERR_OPENCV", "OpenCV não carregou", null)
      val sealed = kind == "sealed"
      if (!indexOf(kind).ready) throw CodedException("ERR_INDEX", "Banco ainda não carregado", null)
      val bmp = loadBitmap(ctx, Uri.parse(uri), 1600)
      val mat = Mat()
      Utils.bitmapToMat(bmp, mat)
      bmp.recycle()
      val t0 = System.currentTimeMillis()
      val quads = if (sealed) emptyList() else CardDetector.candidates(mat, 5)
      val r = if (sealed) SealedRecognizer.recognize(mat, 2f) else CardRecognizer.recognize(mat, quads, true, 4, 0.8f)
      val lang = if (sealed && r != null) SealedRecognizer.detectLanguage(mat, r.quad) else null
      val w = mat.cols()
      val h = mat.rows()
      mat.release()
      if (r == null) {
        mapOf("matches" to emptyList<Any>(), "ms" to (System.currentTimeMillis() - t0).toInt())
      } else {
        mapOf(
          "id" to r.top.id,
          "lang" to (lang ?: ""),
          "score" to r.top.score.toDouble(),
          "guide" to r.guide,
          "candidates" to quads.size,
          "ms" to (System.currentTimeMillis() - t0).toInt(),
          "quad" to r.quad.flatMap { listOf(it.x / w, it.y / h) },
          "matches" to r.matches.map { mapOf("id" to it.id, "score" to it.score.toDouble()) }
        )
      }
    }

    // Conferir preço: foto ou print (anúncio, slab, lacrado). Tenta carta e lacrado, e lê o texto da imagem.
    AsyncFunction("analyzeImageAsync") { uri: String, cardStrong: Double, sealedStrong: Double ->
      val ctx = appContext.reactContext ?: throw CodedException("ERR_CONTEXT", "Contexto indisponível", null)
      if (!CardDetector.ensureLoaded()) throw CodedException("ERR_OPENCV", "OpenCV não carregou", null)
      val bmp = loadBitmap(ctx, Uri.parse(uri), 1600)
      val text = TextReader.read(bmp, 6)
      val mat = Mat()
      Utils.bitmapToMat(bmp, mat)
      bmp.recycle()
      val t0 = System.currentTimeMillis()
      val w = mat.cols()
      val h = mat.rows()
      fun pack(r: FrameMatch?, extra: Map<String, Any> = emptyMap()): Map<String, Any>? = r?.let {
        mapOf(
          "id" to it.top.id,
          "score" to it.top.score.toDouble(),
          "quad" to it.quad.flatMap { p -> listOf(p.x / w, p.y / h) },
          "matches" to it.matches.map { m -> mapOf("id" to m.id, "score" to m.score.toDouble()) }
        ) + extra
      }
      var card: FrameMatch? = null
      var label = ""
      if (CardIndex.ready) {
        val quads = CardDetector.candidates(mat, 10)
        card = CardRecognizer.recognize(mat, quads, true, 10, 0.8f)
        if (card == null || card.top.score < cardStrong) {
          val g = CardRecognizer.recognize(mat, emptyList(), false, 0, 0f, 2f, CardDetector.gridQuads(w, h, doubleArrayOf(0.35, 0.55, 0.85)))
          if (g != null && (card == null || g.top.score > card.top.score)) card = g
        }
        card?.let { label = TextReader.slabLabel(mat, it.quad) }
      }
      var sealed: FrameMatch? = null
      var lang: String? = null
      if (SealedIndex.ready) {
        sealed = SealedRecognizer.recognize(mat, sealedStrong.toFloat(), true)
        sealed?.let { lang = SealedRecognizer.detectLanguage(mat, it.quad) }
      }
      mat.release()
      mapOf(
        "card" to pack(card, mapOf("label" to label)),
        "sealed" to pack(sealed, mapOf("lang" to (lang ?: ""))),
        "text" to text,
        "ms" to (System.currentTimeMillis() - t0).toInt()
      )
    }

    View(CardScannerView::class) {
      Events("onCard", "onTrack", "onCameraReady", "onCameraError")

      Prop("active") { view: CardScannerView, v: Boolean -> view.active = v }
      Prop("paused") { view: CardScannerView, v: Boolean -> view.paused = v }
      Prop("mode") { view: CardScannerView, v: String -> view.mode = v }
      Prop("zoom") { view: CardScannerView, v: Double -> view.zoom = v.toFloat() }
      Prop("torch") { view: CardScannerView, v: Boolean -> view.torch = v }
      Prop("minScore") { view: CardScannerView, v: Double -> view.minScore = v.toFloat() }
      Prop("strongScore") { view: CardScannerView, v: Double -> view.strongScore = v.toFloat() }

      OnViewDestroys { view: CardScannerView -> view.release() }
    }
  }

  private fun indexOf(kind: String?): VisionIndex = if (kind == "sealed") SealedIndex else CardIndex

  private fun toFile(p: String): File = File(if (p.startsWith("file:")) Uri.parse(p).path!! else p)

  private fun loadBitmap(ctx: Context, uri: Uri, maxSide: Int): Bitmap {
    val raw = uri.toString()
    // imagem embutida no APK (expo-asset em release devolve só o nome do recurso)
    val resId = if (uri.scheme == null && !raw.startsWith("/")) {
      ctx.resources.getIdentifier(raw, "drawable", ctx.packageName).takeIf { it != 0 }
        ?: ctx.resources.getIdentifier(raw, "raw", ctx.packageName)
    } else 0
    val open = {
      when {
        resId != 0 -> ctx.resources.openRawResource(resId)
        uri.scheme == null || uri.scheme == "file" -> File(uri.path ?: raw).inputStream()
        else -> ctx.contentResolver.openInputStream(uri) ?: throw CodedException("ERR_IMAGE", "Não consegui abrir a imagem", null)
      }
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
