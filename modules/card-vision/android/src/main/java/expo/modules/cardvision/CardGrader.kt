package expo.modules.cardvision

import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Rect
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Pré-avaliação para graduação: centralização (larguras da moldura), branco nos cantos/bordas
 * e riscos finos no verso. Mesmo algoritmo de vision/grading.py — manter em sincronia.
 * Tudo é medido na carta "endireitada" a 20 px/mm (63 x 88 mm -> 1260 x 1760).
 */
object CardGrader {
  private const val PX = 20
  private const val CW = 63 * PX
  private const val CH = 88 * PX
  private const val CORNER_R = 2.8 * PX
  private const val BAND_MIN = 4f
  private const val BAND_MAX = 16f
  private const val DEEP_MIN = 24f
  private const val DEEP_MAX = 48f

  data class Spot(val x: Int, val y: Int, val w: Int, val h: Int, val mm: Double)

  /** Distância (px) até a beirada da carta com cantos arredondados. */
  private val dist: FloatArray by lazy {
    val m = Mat.zeros(CH + 2, CW + 2, CvType.CV_8U)
    val r = CORNER_R.roundToInt()
    val white = Scalar(255.0)
    Imgproc.rectangle(m, Point(1.0 + r, 1.0), Point(CW - r.toDouble(), CH.toDouble()), white, -1)
    Imgproc.rectangle(m, Point(1.0, 1.0 + r), Point(CW.toDouble(), CH - r.toDouble()), white, -1)
    for ((cx, cy) in listOf(Pair(1 + r, 1 + r), Pair(CW - r, 1 + r), Pair(CW - r, CH - r), Pair(1 + r, CH - r))) {
      Imgproc.circle(m, Point(cx.toDouble(), cy.toDouble()), r, white, -1)
    }
    val d = Mat()
    Imgproc.distanceTransform(m, d, Imgproc.DIST_L2, 5)
    m.release()
    val inner = Mat(d, Rect(1, 1, CW, CH)).clone()
    d.release()
    val out = FloatArray(CW * CH)
    inner.get(0, 0, out)
    inner.release()
    out
  }

  // ---------- borda exata da carta ----------

  /** Valor bilinear do canal [c] (imagem com [ch] canais intercalados). */
  private fun sample(g: ByteArray, w: Int, h: Int, ch: Int, c: Int, x: Double, y: Double): Double {
    val xx = x.coerceIn(0.0, w - 1.001)
    val yy = y.coerceIn(0.0, h - 1.001)
    val x0 = xx.toInt()
    val y0 = yy.toInt()
    val fx = xx - x0
    val fy = yy - y0
    fun p(a: Int, b: Int) = (g[(b * w + a) * ch + c].toInt() and 0xff).toDouble()
    return (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy
  }

  /**
   * Procura o degrau de cor mais de fora perto de cada lado e ajusta uma reta (precisão de fração de pixel).
   * Usa a soma dos canais: borda azul-escura do verso sobre fundo preto quase não muda o brilho.
   */
  fun refineQuad(img: Mat, q: Array<Point>): Array<Point> {
    val w = img.cols()
    val h = img.rows()
    val chn = img.channels()
    val g = ByteArray(w * h * chn)
    img.get(0, 0, g)
    val cx = q.sumOf { it.x } / 4
    val cy = q.sumOf { it.y } / 4
    val lines = ArrayList<DoubleArray>() // x0, y0, vx, vy
    for (i in 0 until 4) {
      val a = q[i]
      val b = q[(i + 1) % 4]
      val len = hypot(b.x - a.x, b.y - a.y)
      val dx = (b.x - a.x) / len
      val dy = (b.y - a.y) / len
      var nx = -dy
      var ny = dx
      if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) {
        nx = -nx; ny = -ny
      }
      val r = max(4.0, 0.035 * len)
      val n = (2 * r / 0.5).toInt() + 1
      val prof = Array(3) { DoubleArray(n) }
      val sm = Array(3) { DoubleArray(n) }
      val der = DoubleArray(n - 1)
      val pts = ArrayList<Point>()
      for (k in 0 until 48) {
        val t = 0.08 + 0.84 * k / 47
        val px = a.x + t * (b.x - a.x)
        val py = a.y + t * (b.y - a.y)
        for (c in 0 until 3) {
          val cc = if (chn >= 3) c else 0
          for (j in 0 until n) {
            val s = -r + 0.5 * j
            prof[c][j] = sample(g, w, h, chn, cc, px + s * nx, py + s * ny)
          }
          for (j in 0 until n) sm[c][j] = (prof[c][max(0, j - 1)] + prof[c][j] + prof[c][min(n - 1, j + 1)]) / 3
        }
        var mx = 0.0
        java.util.Arrays.fill(der, 0.0)
        for (j in 2 until n - 3) {
          der[j] = abs(sm[0][j + 1] - sm[0][j]) + abs(sm[1][j + 1] - sm[1][j]) + abs(sm[2][j + 1] - sm[2][j])
          if (der[j] > mx) mx = der[j]
        }
        if (mx < 15) continue
        val lim = max(15.0, 0.45 * mx)
        var kk = -1
        for (j in n - 4 downTo 2) if (der[j] >= lim) {
          kk = j; break
        }
        if (kk < 0) continue
        val s = -r + 0.5 * kk + 0.25
        pts.add(Point(px + s * nx, py + s * ny))
      }
      if (pts.size < 12) return q
      val mp = MatOfPoint2f(*pts.toTypedArray())
      val line = Mat()
      Imgproc.fitLine(mp, line, Imgproc.DIST_HUBER, 0.0, 0.01, 0.01)
      val v = FloatArray(4)
      line.get(0, 0, v)
      mp.release(); line.release()
      lines.add(doubleArrayOf(v[2].toDouble(), v[3].toDouble(), v[0].toDouble(), v[1].toDouble()))
    }
    val out = Array(4) { Point() }
    for (i in 0 until 4) {
      val l1 = lines[(i + 3) % 4]
      val l2 = lines[i]
      // l1.p + s*l1.v = l2.p + t*l2.v
      val det = l1[2] * (-l2[3]) - (-l2[2]) * l1[3]
      if (abs(det) < 1e-9) return q
      val bx = l2[0] - l1[0]
      val by = l2[1] - l1[1]
      val s = (bx * (-l2[3]) - (-l2[2]) * by) / det
      out[i] = Point(l1[0] + s * l1[2], l1[1] + s * l1[3])
    }
    val side = hypot(q[1].x - q[0].x, q[1].y - q[0].y)
    for (i in 0 until 4) if (abs(out[i].x - q[i].x) > 0.06 * side || abs(out[i].y - q[i].y) > 0.06 * side) return q
    return out
  }

  // ---------- medidas ----------

  /** Largura da moldura (px a 20 px/mm) em cada lado; null onde não deu para medir. */
  private fun borderWidths(lab: FloatArray): Map<String, Double?> {
    val out = HashMap<String, Double?>()
    for (side in listOf("left", "right", "top", "bottom")) {
      val horiz = side == "left" || side == "right"
      val len = if (horiz) CH else CW // ao longo do lado
      val depth = if (horiz) CW else CH // para dentro
      fun idx(along: Int, d: Int): Int {
        val x: Int
        val y: Int
        when (side) {
          "left" -> { x = d; y = along }
          "right" -> { x = CW - 1 - d; y = along }
          "top" -> { x = along; y = d }
          else -> { x = along; y = CH - 1 - d }
        }
        return (y * CW + x) * 3
      }
      val rows = (len * 0.2).toInt() until (len * 0.8).toInt() step 4
      // cor da moldura: mediana entre 0,4 e 1,1 mm
      val refs = Array(3) { ArrayList<Float>() }
      for (rr in rows) for (d in (0.4 * PX).toInt() until (1.1 * PX).toInt()) {
        val o = idx(rr, d)
        for (c in 0 until 3) refs[c].add(lab[o + c])
      }
      val ref = FloatArray(3) { c -> refs[c].sorted()[refs[c].size / 2] }
      val x0 = (0.3 * PX).toInt()
      val x1 = (0.16 * depth).toInt()
      val vals = ArrayList<Double>()
      var total = 0
      for (rr in rows) {
        total++
        var run = 0
        for (d in x0 until x1) {
          val o = idx(rr, d)
          val dl = lab[o] - ref[0]
          val da = lab[o + 1] - ref[1]
          val db = lab[o + 2] - ref[2]
          if (sqrt(dl * dl + da * da + db * db) > 22f) {
            run++
            if (run == 6) {
              vals.add((d - 5).toDouble()); break
            }
          } else run = 0
        }
      }
      if (vals.size < 10 || vals.size < 0.6 * total) {
        out[side] = null; continue
      }
      vals.sort()
      val med = vals[vals.size / 2]
      val dev = vals.map { abs(it - med) }.sorted()
      val mad = dev[dev.size / 2]
      out[side] = if (mad < 0.25 * PX + 0.08 * med) med else null
    }
    return out
  }

  private fun ratio(a: Double?, b: Double?): Double? =
    if (a == null || b == null || a + b <= 0) null else 100.0 * max(a, b) / (a + b)

  /** Manchas brancas que encostam na beirada (desgaste) e quanto da borda tem reflexo. */
  private fun wear(lab8: ByteArray): Triple<List<Spot>, Boolean, Double> {
    val d = dist
    val n = CW * CH
    val lc = FloatArray(n)
    val ch = FloatArray(n)
    for (i in 0 until n) {
      val o = i * 3
      lc[i] = (lab8[o].toInt() and 0xff) * 100f / 255f
      val a = (lab8[o + 1].toInt() and 0xff) - 128f
      val b = (lab8[o + 2].toInt() and 0xff) - 128f
      ch[i] = sqrt(a * a + b * b)
    }
    val dl = ArrayList<Float>()
    val dc = ArrayList<Float>()
    for (i in 0 until n step 3) if (d[i] >= DEEP_MIN && d[i] <= DEEP_MAX) {
      dl.add(lc[i]); dc.add(ch[i])
    }
    dl.sort(); dc.sort()
    val refL = if (dl.isEmpty()) 50f else dl[dl.size / 2]
    val refC = if (dc.isEmpty()) 0f else dc[dc.size / 2]
    val colored = refC > 18f
    val tL = min(96f, refL + 22f)
    val tC = max(10f, 0.45f * refC)
    val wb = ByteArray(n)
    for (i in 0 until n) if (d[i] > 0f && d[i] <= 3 * PX && lc[i] > tL && ch[i] < tC) wb[i] = 1
    val wm = Mat(CH, CW, CvType.CV_8U)
    wm.put(0, 0, wb)
    val k2 = Mat.ones(2, 2, CvType.CV_8U)
    Imgproc.morphologyEx(wm, wm, Imgproc.MORPH_OPEN, k2)
    k2.release()
    val labels = Mat()
    val stats = Mat()
    val cents = Mat()
    val nc = Imgproc.connectedComponentsWithStats(wm, labels, stats, cents, 8, CvType.CV_32S)
    wm.release(); cents.release()
    val lb = IntArray(n)
    labels.get(0, 0, lb)
    labels.release()
    val minD = FloatArray(nc) { Float.MAX_VALUE }
    val maxD = FloatArray(nc)
    for (i in 0 until n) {
      val l = lb[i]
      if (l == 0) continue
      if (d[i] < minD[l]) minD[l] = d[i]
      if (d[i] > maxD[l]) maxD[l] = d[i]
    }
    val st = IntArray(nc * 5)
    stats.get(0, 0, st)
    stats.release()
    val spots = ArrayList<Spot>()
    var glarePx = 0
    for (l in 1 until nc) {
      if (minD[l] > BAND_MAX) continue
      val x = st[l * 5]
      val y = st[l * 5 + 1]
      val w = st[l * 5 + 2]
      val h = st[l * 5 + 3]
      val a = st[l * 5 + 4]
      if (maxD[l] <= 2 * PX) {
        val mm = max(w, h).toDouble() / PX
        if (mm >= 0.2) spots.add(Spot(x, y, w, h, mm))
      } else glarePx += a
    }
    var ring = 0
    for (i in 0 until n) if (d[i] > 0f && d[i] <= 3 * PX) ring++
    return Triple(spots, colored, glarePx.toDouble() / max(1, ring))
  }

  /** Riscos finos e claros (linhas longas e estreitas) longe da beirada. */
  private fun scratches(lab: Mat): List<Rect> {
    val ch = ArrayList<Mat>()
    Core.split(lab, ch)
    val l = ch[0]
    ch.drop(1).forEach { it.release() }
    val th = Mat()
    val ker = Imgproc.getStructuringElement(Imgproc.MORPH_ELLIPSE, Size(11.0, 11.0))
    Imgproc.morphologyEx(l, th, Imgproc.MORPH_TOPHAT, ker)
    ker.release(); l.release()
    val n = CW * CH
    val tb = ByteArray(n)
    th.get(0, 0, tb)
    th.release()
    val d = dist
    for (i in 0 until n) tb[i] = if ((tb[i].toInt() and 0xff) > 22 && d[i] > 2.5 * PX) 1 else 0
    val m = Mat(CH, CW, CvType.CV_8U)
    m.put(0, 0, tb)
    val labels = Mat()
    val stats = Mat()
    val cents = Mat()
    val nc = Imgproc.connectedComponentsWithStats(m, labels, stats, cents, 8, CvType.CV_32S)
    m.release(); cents.release()
    val st = IntArray(nc * 5)
    stats.get(0, 0, st)
    stats.release()
    val keep = HashSet<Int>()
    for (k in 1 until nc) if (max(st[k * 5 + 2], st[k * 5 + 3]) >= 2.5 * PX && st[k * 5 + 4] >= 15) keep.add(k)
    val out = ArrayList<Rect>()
    if (keep.isNotEmpty()) {
      val lb = IntArray(n)
      labels.get(0, 0, lb)
      val pts = HashMap<Int, ArrayList<Point>>()
      for (i in 0 until n) {
        val k = lb[i]
        if (k != 0 && k in keep) pts.getOrPut(k) { ArrayList() }.add(Point((i % CW).toDouble(), (i / CW).toDouble()))
      }
      for ((k, p) in pts) {
        val mp = MatOfPoint2f(*p.toTypedArray())
        val rr = Imgproc.minAreaRect(mp)
        mp.release()
        val length = max(rr.size.width, rr.size.height)
        val thick = st[k * 5 + 4] / max(1.0, length)
        if (length < 2.5 * PX || thick > 8 || length / max(1.0, thick) < 12) continue
        out.add(Rect(st[k * 5], st[k * 5 + 1], st[k * 5 + 2], st[k * 5 + 3]))
      }
    }
    labels.release()
    return out
  }

  // ---------- tudo junto ----------

  fun assess(src: Mat, side: String, outFile: File): Map<String, Any?> {
    val quads = CardDetector.candidates(src, 3)
    if (quads.isEmpty()) return mapOf("ok" to false, "error" to "nocard")
    val q = refineQuad(src, quads[0])
    val wTop = CardDetector.dist(q[0], q[1])
    val wBot = CardDetector.dist(q[3], q[2])
    val hL = CardDetector.dist(q[0], q[3])
    val hR = CardDetector.dist(q[1], q[2])
    val aspect = ((hL + hR) / 2) / ((wTop + wBot) / 2)
    // fora de esquadro: lados opostos muito diferentes = celular inclinado
    val tilt = max(abs(wTop - wBot) / max(wTop, wBot), abs(hL - hR) / max(hL, hR))

    val m = Imgproc.getPerspectiveTransform(
      MatOfPoint2f(*q),
      MatOfPoint2f(Point(0.0, 0.0), Point(CW.toDouble(), 0.0), Point(CW.toDouble(), CH.toDouble()), Point(0.0, CH.toDouble()))
    )
    val warped = Mat()
    Imgproc.warpPerspective(src, warped, m, Size(CW.toDouble(), CH.toDouble()), Imgproc.INTER_CUBIC, Core.BORDER_REPLICATE)
    m.release()
    val rgb = Mat()
    if (warped.channels() == 4) Imgproc.cvtColor(warped, rgb, Imgproc.COLOR_RGBA2RGB) else warped.copyTo(rgb)
    warped.release()
    val lab8m = Mat()
    Imgproc.cvtColor(rgb, lab8m, Imgproc.COLOR_RGB2Lab)
    val lab8 = ByteArray(CW * CH * 3)
    lab8m.get(0, 0, lab8)
    val labF = Mat()
    lab8m.convertTo(labF, CvType.CV_32F)
    Imgproc.GaussianBlur(labF, labF, Size(0.0, 0.0), 1.2)
    val labArr = FloatArray(CW * CH * 3)
    labF.get(0, 0, labArr)
    labF.release()

    val bw = borderWidths(labArr)
    val (spots, colored, glare) = wear(lab8)
    val scr = if (side == "back") scratches(lab8m) else emptyList()
    lab8m.release()

    // imagem anotada (metade do tamanho): moldura medida, manchas e riscos
    val green = Scalar(52.0, 211.0, 153.0)
    val red = Scalar(248.0, 60.0, 60.0)
    val yellow = Scalar(250.0, 204.0, 21.0)
    bw["left"]?.let { Imgproc.line(rgb, Point(it, 0.0), Point(it, CH.toDouble()), green, 3) }
    bw["right"]?.let { Imgproc.line(rgb, Point(CW - it, 0.0), Point(CW - it, CH.toDouble()), green, 3) }
    bw["top"]?.let { Imgproc.line(rgb, Point(0.0, it), Point(CW.toDouble(), it), green, 3) }
    bw["bottom"]?.let { Imgproc.line(rgb, Point(0.0, CH - it), Point(CW.toDouble(), CH - it), green, 3) }
    for (s in spots) {
      val c = Point(s.x + s.w / 2.0, s.y + s.h / 2.0)
      Imgproc.circle(rgb, c, max(18, max(s.w, s.h)), red, 5)
    }
    for (r in scr) Imgproc.rectangle(rgb, Point(r.x - 8.0, r.y - 8.0), Point(r.x + r.width + 8.0, r.y + r.height + 8.0), yellow, 5)
    val small = Mat()
    Imgproc.resize(rgb, small, Size(CW / 2.0, CH / 2.0), 0.0, 0.0, Imgproc.INTER_AREA)
    rgb.release()
    val bgr = Mat()
    Imgproc.cvtColor(small, bgr, Imgproc.COLOR_RGB2BGR)
    small.release()
    Imgcodecs.imwrite(outFile.absolutePath, bgr)
    bgr.release()

    fun mm(v: Double?) = v?.let { (it / PX * 100).roundToInt() / 100.0 }
    val k = 4 * PX
    val regions = listOf(
      Triple("corner_tl", Rect(0, 0, k, k), true), Triple("corner_tr", Rect(CW - k, 0, k, k), true),
      Triple("corner_br", Rect(CW - k, CH - k, k, k), true), Triple("corner_bl", Rect(0, CH - k, k, k), true),
      Triple("edge_left", Rect(0, k, k, CH - 2 * k), false), Triple("edge_right", Rect(CW - k, k, k, CH - 2 * k), false),
      Triple("edge_top", Rect(k, 0, CW - 2 * k, k), false), Triple("edge_bottom", Rect(k, CH - k, CW - 2 * k, k), false)
    ).map { (name, r, corner) ->
      val mine = spots.filter {
        val cx = it.x + it.w / 2.0
        val cy = it.y + it.h / 2.0
        cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height
      }
      mapOf("name" to name, "corner" to corner, "mm" to (mine.maxOfOrNull { it.mm } ?: 0.0), "count" to mine.size)
    }
    return mapOf(
      "ok" to true,
      "side" to side,
      "borders" to mapOf("left" to mm(bw["left"]), "right" to mm(bw["right"]), "top" to mm(bw["top"]), "bottom" to mm(bw["bottom"])),
      "lr" to ratio(bw["left"], bw["right"]),
      "tb" to ratio(bw["top"], bw["bottom"]),
      "colored" to colored,
      "glare" to glare,
      "regions" to regions,
      "scratches" to scr.size,
      "cardPx" to ((hL + hR) / 2),
      "aspect" to aspect,
      "tilt" to tilt,
      "image" to "file://" + outFile.absolutePath
    )
  }
}
