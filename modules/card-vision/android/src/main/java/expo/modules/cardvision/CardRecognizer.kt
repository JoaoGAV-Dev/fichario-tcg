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
    flipBelow: Float,
    refineBelow: Float = 2f,
    extra: List<Array<Point>> = emptyList()
  ): FrameMatch? {
    val list = ArrayList<Pair<Array<Point>, Boolean>>()
    quads.take(maxCand).forEach { q ->
      list.add(Pair(q, false))
      CardDetector.slabInner(q)?.let { list.add(Pair(it, false)) }
    }
    if (useGuide) CardDetector.guideQuads(src.cols(), src.rows()).forEach { list.add(Pair(it, true)) }
    extra.forEach { list.add(Pair(it, true)) }
    var best: FrameMatch? = null
    for ((q, g) in list) {
      val m = embedSearch(src, q, false)
      if (m.isNotEmpty() && (best == null || m[0].score > best.top.score)) best = FrameMatch(q, g, m)
    }
    // ajuste fino em volta do melhor recorte (fichário, sleeve, carta fora do centro)
    val b0 = best
    if (b0 != null && b0.top.score < refineBelow) {
      for (q in CardDetector.perturb(b0.quad)) {
        val m = embedSearch(src, q, false)
        if (m.isNotEmpty() && m[0].score > best!!.top.score) best = FrameMatch(q, b0.guide, m)
      }
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
