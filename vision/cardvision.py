"""Detecção da carta na imagem + recorte, igual ao que o app faz em Kotlin (CardDetector.kt).

Mantenha os dois em sincronia: os números daqui são os mesmos do app.
"""
import cv2
import numpy as np

# Tamanho da carta "endireitada" que entra no modelo (largura x altura, proporção 63x88 mm).
W, H = 224, 312
# Recorte da arte (frações da carta): y0, y1, x0, x1
ART = (0.10, 0.52, 0.07, 0.93)
ART_H, ART_W = 160, 224
DETECT_W = 480


def order(pts):
    pts = np.asarray(pts, np.float32).reshape(4, 2)
    s = pts.sum(1)
    d = (pts[:, 1] - pts[:, 0])
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(d)]
    bl = pts[np.argmax(d)]
    return np.array([tl, tr, br, bl], np.float32)


def _quad_score(q, img_area):
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    if w < 8 or h < 8:
        return None
    ratio = h / w  # carta em pé: altura/largura ~ 1,397
    area = cv2.contourArea(q)
    if area < 0.02 * img_area or area > 0.97 * img_area:
        return None
    if not (1.22 <= ratio <= 1.62):
        return None
    # prefere as maiores e as de proporção mais próxima de carta
    return (area / img_area) * (1.0 - min(0.6, abs(ratio - 1.397) * 2.0))


def candidates(gray, max_n=3):
    """Quadriláteros com cara de carta em pé. gray já reduzido (DETECT_W de largura)."""
    Hh, Ww = gray.shape
    img_area = float(Hh * Ww)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    v = float(np.median(blur))
    found = []
    for lo, hi in [(int(max(0, 0.66 * v)), int(min(255, 1.33 * v))), (30, 90), (60, 180)]:
        edges = cv2.Canny(blur, lo, hi)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
        cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            a = cv2.contourArea(c)
            if a < 0.02 * img_area:
                continue
            peri = cv2.arcLength(c, True)
            quad = None
            for eps in (0.02, 0.035, 0.05):
                ap = cv2.approxPolyDP(c, eps * peri, True)
                if len(ap) == 4 and cv2.isContourConvex(ap):
                    quad = ap
                    break
            if quad is None:
                box = cv2.boxPoints(cv2.minAreaRect(c))
                if a / max(1.0, cv2.contourArea(box)) > 0.85:
                    quad = box
            if quad is None:
                continue
            q = order(quad)
            s = _quad_score(q, img_area)
            if s is None:
                continue
            # descarta quase-duplicados (mesmo contorno achado em outro limiar)
            dup = False
            for i, (s2, q2) in enumerate(found):
                if np.abs(q2 - q).max() < 0.03 * Ww:
                    dup = True
                    if s > s2:
                        found[i] = (s, q)
                    break
            if not dup:
                found.append((s, q))
    found.sort(key=lambda t: -t[0])
    return [q for _, q in found[:max_n]]


def guide_quad(img_w, img_h):
    """Recorte central do tamanho de uma carta (quando a borda não aparece)."""
    w = 0.78 * img_w
    h = w * 88 / 63
    if h > 0.9 * img_h:
        h = 0.9 * img_h
        w = h * 63 / 88
    x0 = (img_w - w) / 2
    y0 = (img_h - h) / 2
    return np.array([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], np.float32)


def warp(img, q, w=W, h=H):
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    M = cv2.getPerspectiveTransform(np.asarray(q, np.float32), dst)
    return cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)


def find_quads(img_rgb):
    """Candidatos na imagem inteira (coordenadas da imagem original) + recorte central."""
    h0, w0 = img_rgb.shape[:2]
    s = DETECT_W / w0
    small = cv2.resize(img_rgb, (DETECT_W, int(round(h0 * s))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    qs = [q / s for q in candidates(gray)]
    return qs, guide_quad(w0, h0)
