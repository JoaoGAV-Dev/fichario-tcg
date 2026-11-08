package expo.modules.cardvision

import org.opencv.android.OpenCVLoader
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Acha a carta na imagem (quadrilátero em pé com proporção de carta) e "endireita" o recorte.
 * Mesmo algoritmo de vision/cardvision.py (usado para gerar e testar o banco) — manter em sincronia.
 */
object CardDetector {
  const val W = 224
  const val H = 312
  private const val DETECT_W = 480.0

  @Volatile private var loaded = false

  fun ensureLoaded(): Boolean {
    if (!loaded) {
      synchronized(this) {
        if (!loaded) loaded = OpenCVLoader.initLocal()
      }
    }
    return loaded
  }

  /** Cantos em ordem: topo-esq, topo-dir, baixo-dir, baixo-esq. */
  fun order(p: Array<Point>): Array<Point> {
    val tl = p.minByOrNull { it.x + it.y }!!
    val br = p.maxByOrNull { it.x + it.y }!!
    val tr = p.minByOrNull { it.y - it.x }!!
    val bl = p.maxByOrNull { it.y - it.x }!!
    return arrayOf(tl, tr, br, bl)
  }

  fun dist(a: Point, b: Point) = hypot(a.x - b.x, a.y - b.y)

  fun quadHeight(q: Array<Point>) = (dist(q[3], q[0]) + dist(q[2], q[1])) / 2

  private fun quadScore(q: Array<Point>, imgArea: Double): Double? {
    val w = (dist(q[1], q[0]) + dist(q[2], q[3])) / 2
    val h = quadHeight(q)
    if (w < 8 || h < 8) return null
    val ratio = h / w
    val area = MatOfPoint2f(*q).let { m -> Imgproc.contourArea(m).also { m.release() } }
    if (area < 0.02 * imgArea || area > 0.97 * imgArea) return null
    if (ratio < 1.22 || ratio > 1.62) return null
    return (area / imgArea) * (1.0 - min(0.6, abs(ratio - 1.397) * 2.0))
  }

  private fun median(gray: Mat): Double {
    val n = (gray.total() * gray.channels()).toInt()
    val bytes = ByteArray(n)
    gray.get(0, 0, bytes)
    val hist = IntArray(256)
    for (b in bytes) hist[b.toInt() and 0xff]++
    var acc = 0
    val half = n / 2
    for (i in 0 until 256) {
      acc += hist[i]
      if (acc > half) return i.toDouble()
    }
    return 128.0
  }

  /** Até [maxN] quadriláteros candidatos, em coordenadas de [src] (RGBA ou RGB). */
  fun candidates(src: Mat, maxN: Int = 3): List<Array<Point>> {
    val s = DETECT_W / src.cols()
    val small = Mat()
    Imgproc.resize(src, small, Size(DETECT_W, (src.rows() * s).roundToInt().toDouble()), 0.0, 0.0, Imgproc.INTER_AREA)
    val gray = Mat()
    Imgproc.cvtColor(small, gray, if (src.channels() == 4) Imgproc.COLOR_RGBA2GRAY else Imgproc.COLOR_RGB2GRAY)
    small.release()
    val blur = Mat()
    Imgproc.GaussianBlur(gray, blur, Size(5.0, 5.0), 0.0)
    gray.release()
    val imgArea = blur.rows().toDouble() * blur.cols()
    val v = median(blur)
    val kernel = Mat.ones(3, 3, CvType.CV_8U)
    val edges = Mat()
    val hierarchy = Mat()
    val found = ArrayList<Pair<Double, Array<Point>>>()
    val thresholds = listOf(
      Pair(max(0.0, 0.66 * v), min(255.0, 1.33 * v)), Pair(30.0, 90.0), Pair(60.0, 180.0)
    )
    for ((lo, hi) in thresholds) {
      Imgproc.Canny(blur, edges, lo, hi)
      Imgproc.dilate(edges, edges, kernel)
      val cnts = ArrayList<MatOfPoint>()
      Imgproc.findContours(edges, cnts, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
      for (c in cnts) {
        val a = Imgproc.contourArea(c)
        if (a < 0.02 * imgArea) {
          c.release(); continue
        }
        val c2 = MatOfPoint2f(*c.toArray())
        val peri = Imgproc.arcLength(c2, true)
        var quad: Array<Point>? = null
        for (eps in doubleArrayOf(0.02, 0.035, 0.05)) {
          val ap = MatOfPoint2f()
          Imgproc.approxPolyDP(c2, ap, eps * peri, true)
          if (ap.total() == 4L) {
            val pts = ap.toArray()
            val mp = MatOfPoint(*pts)
            val convex = Imgproc.isContourConvex(mp)
            mp.release()
            if (convex) {
              quad = pts; ap.release(); break
            }
          }
          ap.release()
        }
        if (quad == null) {
          val rect = Imgproc.minAreaRect(c2)
          val box = arrayOfNulls<Point>(4)
          rect.points(box)
          val boxArea = rect.size.area()
          if (a / max(1.0, boxArea) > 0.85) quad = box.requireNoNulls()
        }
        c2.release(); c.release()
        if (quad == null) continue
        val q = order(quad)
        val sc = quadScore(q, imgArea) ?: continue
        var dup = false
        for (i in found.indices) {
          val q2 = found[i].second
          var md = 0.0
          for (k in 0 until 4) md = max(md, max(abs(q2[k].x - q[k].x), abs(q2[k].y - q[k].y)))
          if (md < 0.03 * DETECT_W) {
            dup = true
            if (sc > found[i].first) found[i] = Pair(sc, q)
            break
          }
        }
        if (!dup) found.add(Pair(sc, q))
      }
    }
    blur.release(); edges.release(); hierarchy.release(); kernel.release()
    found.sortByDescending { it.first }
    return found.take(maxN).map { (_, q) -> Array(4) { Point(q[it].x / s, q[it].y / s) } }
  }

  /** Recortes centrais em 3 tamanhos (carta mais perto/longe), para quando a borda não aparece. */
  fun guideQuads(imgW: Int, imgH: Int): List<Array<Point>> =
    listOf(0.5, 0.62, 0.78).map { guideQuad(imgW, imgH, it) }

  /** Pequenas variações do recorte (menor/maior/deslocado) para achar o encaixe que mais bate. */
  fun perturb(q: Array<Point>): List<Array<Point>> {
    val cx = q.sumOf { it.x } / 4
    val cy = q.sumOf { it.y } / 4
    val w = dist(q[1], q[0])
    val h = dist(q[3], q[0])
    val out = ArrayList<Array<Point>>()
    for (f in doubleArrayOf(0.92, 1.08)) out.add(Array(4) { Point(cx + (q[it].x - cx) * f, cy + (q[it].y - cy) * f) })
    for ((dx, dy) in listOf(Pair(0.05, 0.0), Pair(-0.05, 0.0), Pair(0.0, 0.04), Pair(0.0, -0.04))) {
      out.add(Array(4) { Point(q[it].x + dx * w, q[it].y + dy * h) })
    }
    return out
  }

  /** Recorte central do tamanho de uma carta, para quando a borda não aparece. */
  fun guideQuad(imgW: Int, imgH: Int, scale: Double = 0.78): Array<Point> {
    var w = scale * imgW
    var h = w * 88.0 / 63.0
    if (h > 0.9 * imgH) {
      h = 0.9 * imgH
      w = h * 63.0 / 88.0
    }
    val x0 = (imgW - w) / 2
    val y0 = (imgH - h) / 2
    return arrayOf(Point(x0, y0), Point(x0 + w, y0), Point(x0 + w, y0 + h), Point(x0, y0 + h))
  }

  /** Recorte endireitado outW x outH em RGB (CV_8UC3). */
  fun warp(src: Mat, quad: Array<Point>, rotate180: Boolean = false, outW: Int = W, outH: Int = H): Mat {
    var img = src
    var q = quad
    val qh = max(quadHeight(q), (dist(q[1], q[0]) + dist(q[2], q[3])) / 2 * outH / outW)
    var scaled: Mat? = null
    if (qh > 1.6 * outH) {
      val f = 1.2 * outH / qh
      scaled = Mat()
      Imgproc.resize(
        src, scaled,
        Size(max(1, (src.cols() * f).roundToInt()).toDouble(), max(1, (src.rows() * f).roundToInt()).toDouble()),
        0.0, 0.0, Imgproc.INTER_AREA
      )
      img = scaled
      q = Array(4) { Point(quad[it].x * f, quad[it].y * f) }
    }
    val srcPts = MatOfPoint2f(*q)
    val dstPts = MatOfPoint2f(
      Point(0.0, 0.0), Point(outW - 1.0, 0.0), Point(outW - 1.0, outH - 1.0), Point(0.0, outH - 1.0)
    )
    val m = Imgproc.getPerspectiveTransform(srcPts, dstPts)
    val out = Mat()
    Imgproc.warpPerspective(img, out, m, Size(outW.toDouble(), outH.toDouble()), Imgproc.INTER_LINEAR, Core.BORDER_REPLICATE)
    srcPts.release(); dstPts.release(); m.release(); scaled?.release()
    val rgb = Mat()
    if (out.channels() == 4) Imgproc.cvtColor(out, rgb, Imgproc.COLOR_RGBA2RGB) else out.copyTo(rgb)
    out.release()
    if (rotate180) Core.rotate(rgb, rgb, Core.ROTATE_180)
    return rgb
  }
}
