"""Pré-avaliação para graduação (centralização, cantos/bordas, riscos no verso).

Protótipo de referência do CardGrader.kt — manter os dois em sincronia (mesmos parâmetros).
Medidas em uma carta "endireitada" a 20 px/mm (63 x 88 mm -> 1260 x 1760).
"""
import cv2
import numpy as np

import cardvision as cv

PX_MM = 20
CW, CH = 63 * PX_MM, 88 * PX_MM
CORNER_R = 2.8 * PX_MM          # raio do canto arredondado
BAND = (4, 16)                  # faixa da borda (0,2 a 0,8 mm para dentro) onde aparece o branco
DEEP = (24, 48)                 # faixa de referência da cor da moldura

# PSA: (nota, pior frente, pior verso) — maior lado / soma dos dois lados
PSA_CENTER = [(10, 55, 75), (9, 60, 90), (8, 65, 90), (7, 70, 90), (6, 80, 90), (5, 85, 90), (4, 85, 90)]


def refine_quad(img, q):
    """Bordas exatas: procura o maior degrau de brilho perto de cada lado e ajusta uma reta."""
    q = np.asarray(q, np.float64)
    ctr = q.mean(0)
    lines = []
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        d = b - a
        L = np.hypot(*d)
        d /= L
        n = np.array([-d[1], d[0]])
        if np.dot((a + b) / 2 - ctr, n) < 0:
            n = -n  # normal para fora da carta
        r = max(4.0, 0.035 * L)
        ss = np.arange(-r, r + 0.01, 0.5)
        pts = []
        for t in np.linspace(0.08, 0.92, 48):
            p = a + t * (b - a)
            xs = (p[0] + ss * n[0]).astype(np.float32)
            ys = (p[1] + ss * n[1]).astype(np.float32)
            # degrau de COR (soma dos canais): borda azul-escura sobre fundo preto quase não muda o brilho
            prof = cv2.remap(img, xs[None, :], ys[None, :], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)[0].astype(np.float64)
            prof = np.stack([np.convolve(prof[:, c], np.ones(3) / 3, 'same') for c in range(3)], 1)
            der = np.abs(np.diff(prof, axis=0)).sum(1)
            der[:2] = 0
            der[-2:] = 0
            mx = der.max()
            if mx < 15:
                continue
            # a borda de verdade é o degrau forte mais de fora (o de dentro é a moldura → arte)
            k = int(np.nonzero(der >= max(15.0, 0.45 * mx))[0][-1])
            s = (ss[k] + ss[k + 1]) / 2
            pts.append(p + s * n)
        if len(pts) < 12:
            return q
        vx, vy, x0, y0 = cv2.fitLine(np.array(pts, np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    out = []
    for i in range(4):
        (p1, v1), (p2, v2) = lines[(i - 1) % 4], lines[i]
        A = np.array([v1, -v2]).T
        try:
            st = np.linalg.solve(A, p2 - p1)
        except np.linalg.LinAlgError:
            return q
        out.append(p1 + st[0] * v1)
    out = np.array(out)
    if np.max(np.abs(out - q)) > 0.06 * np.hypot(*(q[1] - q[0])):
        return q
    return out


def straighten(rgb, q):
    M = cv2.getPerspectiveTransform(np.float32(q), np.float32([[0, 0], [CW, 0], [CW, CH], [0, CH]]))
    return cv2.warpPerspective(rgb, M, (CW, CH), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def border_widths(card):
    """Largura (px) da moldura de cada lado: onde a cor deixa de ser a da borda. None se não deu."""
    lab = cv2.cvtColor(card, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab = cv2.GaussianBlur(lab, (0, 0), 1.2)
    out = {}
    views = {
        'left': lab,
        'right': lab[:, ::-1],
        'top': lab.transpose(1, 0, 2),
        'bottom': lab.transpose(1, 0, 2)[:, ::-1],
    }
    for side, v in views.items():
        h, w = v.shape[:2]
        rows = np.arange(int(0.2 * h), int(0.8 * h), 4)
        ref = np.median(v[rows][:, int(0.4 * PX_MM):int(1.1 * PX_MM)].reshape(-1, 3), 0)
        x0, x1 = int(0.3 * PX_MM), int(0.16 * w)
        seg = v[rows, x0:x1]
        dist = np.linalg.norm(seg - ref, axis=2)
        far = dist > 22
        run = 6
        # primeiro índice com `run` pixels seguidos diferentes da borda
        cs = np.cumsum(np.pad(far.astype(np.int32), ((0, 0), (1, 0))), axis=1)
        ok = (cs[:, run:] - cs[:, :-run]) == run
        found = ok.any(1)
        idx = np.argmax(ok, 1) + x0
        vals = idx[found].astype(np.float64)
        if found.mean() < 0.6 or len(vals) < 10:
            out[side] = None
            continue
        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med)))
        out[side] = med if mad < 0.25 * PX_MM + 0.08 * med else None
        out[side + '_ref'] = ref
    return out


def centering(bw):
    def ratio(a, b):
        if bw.get(a) is None or bw.get(b) is None or bw[a] + bw[b] <= 0:
            return None
        return 100.0 * max(bw[a], bw[b]) / (bw[a] + bw[b])
    return ratio('left', 'right'), ratio('top', 'bottom')


def center_cap(worst, back):
    if worst is None:
        return None
    for g, f, b in PSA_CENTER:
        if worst <= (b if back else f) + 0.5:
            return g
    return 3


def rounded_dist():
    m = np.zeros((CH, CW), np.uint8)
    r = int(CORNER_R)
    cv2.rectangle(m, (r, 0), (CW - 1 - r, CH - 1), 255, -1)
    cv2.rectangle(m, (0, r), (CW - 1, CH - 1 - r), 255, -1)
    for cx, cy in ((r, r), (CW - 1 - r, r), (CW - 1 - r, CH - 1 - r), (r, CH - 1 - r)):
        cv2.circle(m, (cx, cy), r, 255, -1)
    # borda de zeros em volta: a distância é até a beirada da carta (fora da imagem não conta como zero)
    m = cv2.copyMakeBorder(m, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    return cv2.distanceTransform(m, cv2.DIST_L2, 5)[1:-1, 1:-1]


_DIST = None


def wear(card):
    """Branco (desgaste) na faixa da borda, por canto e por lado; e se a foto tem reflexo."""
    global _DIST
    if _DIST is None:
        _DIST = rounded_dist()
    D = _DIST
    lab = cv2.cvtColor(card, cv2.COLOR_RGB2LAB).astype(np.float32)
    Lc = lab[..., 0] * 100 / 255
    chroma = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128)
    band = (D >= BAND[0]) & (D <= BAND[1])
    deep = (D >= DEEP[0]) & (D <= DEEP[1])
    ref_L = float(np.median(Lc[deep]))
    ref_c = float(np.median(chroma[deep]))
    colored = ref_c > 18          # borda amarela/azul: branco aparece bem; prateada/cinza não dá
    white = (Lc > min(96.0, ref_L + 22)) & (chroma < max(10.0, 0.45 * ref_c))
    white = cv2.morphologyEx(white.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    white[D > 3 * PX_MM] = 0
    # manchas brancas que encostam na borda: rasas = desgaste; fundas/grandes = reflexo da luz
    n, lab_cc, stats, _ = cv2.connectedComponentsWithStats(white, connectivity=8)
    spots = []  # (x, y, w, h, tamanho em mm)
    glare_px = 0
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        comp = lab_cc[y:y + h, x:x + w] == i
        dd = D[y:y + h, x:x + w][comp]
        if dd.min() > BAND[1]:
            continue
        if dd.max() <= 2 * PX_MM:
            size = max(w, h) / PX_MM
            if size >= 0.2:
                spots.append((int(x), int(y), int(w), int(h), float(size)))
        else:
            glare_px += a
    ring = float(((D > 0) & (D <= 3 * PX_MM)).sum())
    glare = glare_px / ring
    k = int(4 * PX_MM)
    regions = {
        'canto sup. esq.': (0, 0, k, k),
        'canto sup. dir.': (CW - k, 0, CW, k),
        'canto inf. dir.': (CW - k, CH - k, CW, CH),
        'canto inf. esq.': (0, CH - k, k, CH),
        'lado esquerdo': (0, k, k, CH - k),
        'lado direito': (CW - k, k, CW, CH - k),
        'lado de cima': (k, 0, CW - k, k),
        'lado de baixo': (k, CH - k, CW - k, CH),
    }
    res = {}
    for name, (x0, y0, x1, y1) in regions.items():
        mine = [sp for sp in spots if x0 <= sp[0] + sp[2] / 2 < x1 and y0 <= sp[1] + sp[3] / 2 < y1]
        res[name] = (max([sp[4] for sp in mine], default=0.0), len(mine))
    white = spots
    return res, colored, glare, white


def level(r):
    """(maior mancha em mm, quantidade) -> ok / leve / visível / forte"""
    size, n = r
    if n == 0:
        return 'ok'
    if size >= 1.0 or n >= 6:
        return 'forte'
    if size >= 0.5 or n >= 3:
        return 'visível'
    return 'leve'


def scratches(card):
    """Riscos finos e claros no verso (linhas longas e estreitas)."""
    global _DIST
    if _DIST is None:
        _DIST = rounded_dist()
    L = cv2.cvtColor(card, cv2.COLOR_RGB2LAB)[..., 0]
    th = cv2.morphologyEx(L, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    m = ((th > 22) & (_DIST > 2.5 * PX_MM)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    found = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if max(w, h) < 2.5 * PX_MM or a < 15:
            continue
        ys, xs = np.nonzero(lab[y:y + h, x:x + w] == i)
        (_, _), (rw, rh), _ = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
        length = max(rw, rh)
        thick = a / max(1.0, length)
        if length < 2.5 * PX_MM or thick > 8 or length / max(1.0, thick) < 12:
            continue
        found.append((int(x), int(y), int(w), int(h)))
    return found


def assess(rgb, side='front'):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    qs, _ = cv.find_quads(rgb)
    if not qs:
        return {'error': 'carta não encontrada'}
    q = refine_quad(rgb.astype(np.float32), qs[0])
    card = straighten(rgb, q)
    bw = border_widths(card)
    lr, tb = centering(bw)
    w, colored, glare, wm = wear(card)
    sc = scratches(card) if side == 'back' else []
    return {'quad': q, 'card': card, 'borders': bw, 'lr': lr, 'tb': tb, 'wear': w, 'colored': colored,
            'glare': glare, 'scratches': sc}
