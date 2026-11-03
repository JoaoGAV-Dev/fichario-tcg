package expo.modules.cardocr

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Lê o texto de uma foto (arquivo local) com o ML Kit, no próprio aparelho.
 * Devolve o texto completo e cada linha com a posição, para o app achar o rodapé da carta.
 */
class CardOcrModule : Module() {
  private var recognizer: TextRecognizer? = null

  private fun client(): TextRecognizer =
    recognizer ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { recognizer = it }

  override fun definition() = ModuleDefinition {
    Name("CardOcr")

    Function("isAvailable") { true }

    AsyncFunction("recognizeAsync") { uri: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject(CodedException("ERR_CONTEXT", "Contexto Android indisponível", null))
        return@AsyncFunction
      }
      val image = try {
        InputImage.fromFilePath(context, Uri.parse(uri))
      } catch (e: Exception) {
        promise.reject(CodedException("ERR_IMAGE", e.message ?: "Não consegui abrir a imagem", e))
        return@AsyncFunction
      }
      client().process(image)
        .addOnSuccessListener { result ->
          val lines = ArrayList<Map<String, Any>>()
          for (block in result.textBlocks) {
            for (line in block.lines) {
              val box = line.boundingBox
              lines.add(
                mapOf(
                  "text" to line.text,
                  "x" to (box?.left ?: 0),
                  "y" to (box?.top ?: 0),
                  "width" to (box?.width() ?: 0),
                  "height" to (box?.height() ?: 0)
                )
              )
            }
          }
          promise.resolve(
            mapOf(
              "text" to result.text,
              "lines" to lines,
              "width" to image.width,
              "height" to image.height
            )
          )
        }
        .addOnFailureListener { e ->
          promise.reject(CodedException("ERR_OCR", e.message ?: "Falha no OCR", e))
        }
    }

    OnDestroy {
      recognizer?.close()
      recognizer = null
    }
  }
}
