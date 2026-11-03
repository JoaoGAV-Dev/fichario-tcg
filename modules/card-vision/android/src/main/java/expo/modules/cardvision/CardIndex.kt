package expo.modules.cardvision

import org.opencv.core.CvType
import org.opencv.core.Mat
import org.tensorflow.lite.Interpreter
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import kotlin.math.sqrt

/** Uma carta encontrada: id do TCGdex e semelhança (cosseno, 0..1). */
data class Match(val id: String, val score: Float)

/**
 * Banco de cartas: modelo TFLite que gera a "impressão digital" (vetor de 256 números) de uma
 * imagem de carta, e os vetores de todas as cartas para comparar.
 */
object CardIndex {
  @Volatile var ready = false
    private set
  var version: String = ""
    private set
  var count = 0
    private set

  private var interpreter: Interpreter? = null
  private var dim = 256
  private var emb = FloatArray(0)
  private var ids: Array<String> = emptyArray()
  private val inBuf: ByteBuffer =
    ByteBuffer.allocateDirect(4 * CardDetector.W * CardDetector.H * 3).order(ByteOrder.nativeOrder())
  private val pix = FloatArray(CardDetector.W * CardDetector.H * 3)
  private var out = Array(1) { FloatArray(256) }

  @Synchronized
  fun load(modelFile: File, embFile: File, idsFile: File, dim: Int, version: String) {
    val idList = idsFile.readLines().map { it.trim() }.filter { it.isNotEmpty() }
    val raw = embFile.readBytes()
    val n = raw.size / 2 / dim
    if (n != idList.size) throw IllegalStateException("Banco inconsistente: ${idList.size} ids, $n vetores")
    val sb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val e = FloatArray(n * dim)
    for (i in 0 until n * dim) e[i] = halfToFloat(sb.get(i).toInt() and 0xffff)

    val mapped = FileInputStream(modelFile).use { fis ->
      fis.channel.map(FileChannel.MapMode.READ_ONLY, 0, fis.channel.size())
    }
    val opts = Interpreter.Options().setNumThreads(4)
    val it = Interpreter(mapped, opts)
    val outShape = it.getOutputTensor(0).shape()
    val outDim = outShape[outShape.size - 1]
    if (outDim != dim) throw IllegalStateException("Modelo devolve $outDim números, banco tem $dim")

    interpreter?.close()
    interpreter = it
    this.dim = dim
    this.emb = e
    this.ids = idList.toTypedArray()
    this.count = n
    this.out = Array(1) { FloatArray(dim) }
    this.version = version
    ready = true
  }

  /** Vetor normalizado de um recorte RGB W x H (CV_8UC3). */
  @Synchronized
  fun embed(rgb: Mat): FloatArray {
    val itp = interpreter ?: throw IllegalStateException("Banco de cartas não carregado")
    val f = Mat()
    rgb.convertTo(f, CvType.CV_32FC3)
    f.get(0, 0, pix)
    f.release()
    inBuf.rewind()
    inBuf.asFloatBuffer().put(pix)
    inBuf.rewind()
    itp.run(inBuf, out)
    val v = out[0].copyOf()
    var s = 0.0
    for (x in v) s += x * x
    val inv = (1.0 / sqrt(s + 1e-12)).toFloat()
    for (i in v.indices) v[i] *= inv
    return v
  }

  /** As [k] cartas mais parecidas com o vetor [q]. */
  fun search(q: FloatArray, k: Int = 8): List<Match> {
    val e = emb
    val d = dim
    val n = count
    val topI = IntArray(k) { -1 }
    val topS = FloatArray(k) { -2f }
    for (i in 0 until n) {
      var s = 0f
      val base = i * d
      for (j in 0 until d) s += q[j] * e[base + j]
      if (s > topS[k - 1]) {
        var p = k - 1
        while (p > 0 && topS[p - 1] < s) {
          topS[p] = topS[p - 1]; topI[p] = topI[p - 1]; p--
        }
        topS[p] = s; topI[p] = i
      }
    }
    val res = ArrayList<Match>(k)
    for (p in 0 until k) if (topI[p] >= 0) res.add(Match(ids[topI[p]], topS[p]))
    return res
  }

  private fun halfToFloat(h: Int): Float {
    val s = (h ushr 15) and 1
    val e = (h ushr 10) and 0x1f
    val m = h and 0x3ff
    val bits = when {
      e == 0 -> if (m == 0) s shl 31 else {
        var mm = m
        var ee = -14
        while ((mm and 0x400) == 0) {
          mm = mm shl 1; ee--
        }
        mm = mm and 0x3ff
        (s shl 31) or ((ee + 127) shl 23) or (mm shl 13)
      }
      e == 31 -> (s shl 31) or 0x7f800000 or (m shl 13)
      else -> (s shl 31) or ((e - 15 + 127) shl 23) or (m shl 13)
    }
    return java.lang.Float.intBitsToFloat(bits)
  }
}
