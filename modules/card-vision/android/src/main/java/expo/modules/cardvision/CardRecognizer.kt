package expo.modules.cardvision

import org.opencv.core.Mat
import org.opencv.core.Point

/** Resultado de um quadro: onde está a carta e as cartas mais parecidas. */
class FrameMatch(val quad: Array<Point>, val guide: Boolean, val matches: List<Match>) {
  val top: Match get() = matches[0]
}

object CardRecognizer {
  /**
   * Testa os candidatos de borda (e, se pedido, o recorte central) e fica com o que mais se parece
   * com alguma carta do banco. A própria semelhança valida a detecção: um retângulo que não é carta
   * (teclado, arte interna) dá nota baixa e perde.
   */
  fun recognize(
    src: Mat,
    quads: List<Array<Point>>,
    useGuide: Boolean,
    maxCand: Int,
    flipBelow: Float
  ): FrameMatch? {
    val list = ArrayList<Pair<Array<Point>, Boolean>>()
    quads.take(maxCand).forEach { list.add(Pair(it, false)) }
    if (useGuide) list.add(Pair(CardDetector.guideQuad(src.cols(), src.rows()), true))
    var best: FrameMatch? = null
    for ((q, g) in list) {
      val m = embedSearch(src, q, false)
      if (m.isNotEmpty() && (best == null || m[0].score > best.top.score)) best = FrameMatch(q, g, m)
    }
    // carta de cabeça para baixo
    val b = best
    if (b != null && !b.guide && b.top.score < flipBelow) {
      val m = embedSearch(src, b.quad, true)
      if (m.isNotEmpty() && m[0].score > b.top.score) {
        val q = b.quad
        best = FrameMatch(arrayOf(q[2], q[3], q[0], q[1]), false, m)
      }
    }
    return best
  }

  private fun embedSearch(src: Mat, q: Array<Point>, flip: Boolean): List<Match> {
    val w = CardDetector.warp(src, q, flip)
    val v = try {
      CardIndex.embed(w)
    } finally {
      w.release()
    }
    return CardIndex.search(v, 8)
  }
}
