"""Gera o "banco de cartas" do reconhecimento por imagem (roda no GitHub Actions, de graça).

1. Baixa a lista de cartas em português do TCGdex e as imagens (low.webp).
2. Passa cada imagem por uma rede neural pequena (MobileNet/EfficientNet, pesos ImageNet) e
   gera um vetor ("impressão digital") de 256 números por carta (PCA embutido no modelo).
3. Avalia: cartas distorcidas artificialmente (como uma foto torta, desfocada, com reflexo)
   e fotos reais (vision/real), e escolhe a melhor combinação.
4. Exporta: model.tflite, emb.f16 (N x 256 float16), ids.txt, manifest.json, relatório.

Uso: python vision/build_db.py --eval   (testa variações)  |  sem --eval usa vision/config.json
"""
import argparse
import concurrent.futures as cf
import glob
import io
import json
import os
import random
import re
import sys
import time
import unicodedata

os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")  # Keras 2 (tf_keras): conversão TFLite estável
import cv2
import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from cardvision import ART, ART_H, ART_W, H, W, find_quads, guide_quads, warp  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', 'out')
CACHE = os.path.join(ROOT, '..', 'cache', 'img')
DIM = 256
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.0f}s]', *a, flush=True)


def norm_name(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', s).strip()


# ---------------------------------------------------------------- cartas e imagens

BASIC_PT = {'Grass': 'Energia de Planta', 'Fire': 'Energia de Fogo', 'Water': 'Energia de Água',
            'Lightning': 'Energia Elétrica', 'Psychic': 'Energia Psíquica', 'Fighting': 'Energia de Luta',
            'Darkness': 'Energia de Escuridão', 'Metal': 'Energia de Metal', 'Fairy': 'Energia de Fada'}
# Coleções que o TCGdex não tem (ou não tem imagem) e que vêm do pokemontcg.io
PTCG_EXTRA_SETS = {'sve': 'Energias Escarlate e Violeta', 'mee': 'Energias Megaevolução'}


def _ptcg_set_id(tid):
    t = tid.lower().replace('.5', 'pt5')
    return re.sub(r'(?<=[a-z])0+(?=\d)', '', t)


def _get_json(ses, url, **kw):
    for _ in range(3):
        try:
            r = ses.get(url, timeout=120, **kw)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(2)
    return None


def fetch_cards():
    """Cartas em PT (imagem PT; se não houver, a em inglês) + cartas que só existem no catálogo em inglês
    (promos, energias, coleções ainda sem tradução) + coleções que faltam no TCGdex (pokemontcg.io).
    Cada carta leva os dados para o app mostrar (nome, coleção, data) mesmo sem o TCGdex."""
    ses = requests.Session()
    pt = ses.get('https://api.tcgdex.net/v2/pt/cards', timeout=180).json()
    en = ses.get('https://api.tcgdex.net/v2/en/cards', timeout=180).json()
    en_img = {c['id']: c.get('image') for c in en if c.get('image')}
    # coleções: nome PT (ou EN), data de lançamento e total oficial
    sets_pt = {s['id']: s for s in (_get_json(ses, 'https://api.tcgdex.net/v2/pt/sets') or [])}
    sets_en = {s['id']: s for s in (_get_json(ses, 'https://api.tcgdex.net/v2/en/sets') or [])}
    detail = {}

    def get_detail(sid):
        d = _get_json(ses, f'https://api.tcgdex.net/v2/en/sets/{sid}')
        return sid, d or {}
    with cf.ThreadPoolExecutor(16) as ex:
        for sid, d in ex.map(get_detail, list(sets_en)):
            detail[sid] = d

    novas = sorted(((d.get('releaseDate') or '')[:10], sid, (d.get('cardCount') or {}).get('total'))
                   for sid, d in detail.items() if (d.get('releaseDate') or '') >= '2026-06')
    log('coleções mais novas no TCGdex (lançamento, id, cartas):', novas)

    def set_info(sid):
        d = detail.get(sid, {})
        name = (sets_pt.get(sid) or sets_en.get(sid) or d or {}).get('name', sid)
        cc = (d.get('cardCount') or (sets_en.get(sid) or {}).get('cardCount') or {})
        return name, (d.get('releaseDate') or '')[:10], cc.get('official') or 0

    def set_of(cid):
        return cid.rsplit('-', 1)[0]

    cards = []
    seen = set()
    no_img = []

    def add(cid, name, local, img, src, extra=None):
        sid = set_of(cid)
        sname, rel, off = set_info(sid)
        e = {'id': cid, 'name': name, 'local': local, 'set': sid, 'set_name': sname, 'release': rel,
             'official': off, 'img': img, 'src': src, 'usd': ''}
        if extra:
            e.update(extra)
        cards.append(e)
        seen.add(cid)

    for c in pt:
        img = c.get('image')
        src = 'pt'
        if not img:
            img = en_img.get(c['id'])
            src = 'en'
        if img and '/tcgp/' in img:
            continue
        if not img:
            no_img.append(c)
            continue
        add(c['id'], c.get('name', ''), c.get('localId', ''), img + '/low.webp', src)
    pt_names = {c['id']: c.get('name', '') for c in pt}
    for c in en:
        img = c.get('image')
        if c['id'] in seen or (img and '/tcgp/' in img):
            continue
        if not img:
            if c['id'] not in pt_names:
                no_img.append(c)
            continue
        add(c['id'], c.get('name', ''), c.get('localId', ''), img + '/low.webp', 'en-only')

    # imagens que faltam no TCGdex: tenta o pokemontcg.io (mesma coleção/número)
    ptsets = _get_json(ses, 'https://api.pokemontcg.io/v2/sets', params={'pageSize': 250})
    ptsets = (ptsets or {}).get('data', [])
    ptset_ids = {s['id'] for s in ptsets}
    by_name = {s['name'].lower(): s['id'] for s in ptsets}
    recovered = 0
    from collections import Counter
    log('sem imagem no TCGdex, por coleção:', Counter(set_of(c['id']) for c in no_img).most_common(25))
    for c in no_img:
        sid = set_of(c['id'])
        if '/tcgp/' in str(c.get('image')) or sid.startswith(('A', 'P-A', 'B')) and sid[:1].isupper():
            continue
        ps = _ptcg_set_id(sid)
        if ps not in ptset_ids:
            ps = by_name.get(str((sets_en.get(sid) or {}).get('name', '')).lower())
        name = pt_names.get(c['id']) or c.get('name', '')
        num = str(c.get('localId', '')).lstrip('0') or '0'
        if ps:
            add(c['id'], name, c.get('localId', ''), f'https://images.pokemontcg.io/{ps}/{num}.png', 'ptcg-img')
            recovered += 1
            continue
        # reserva para coleções recém-lançadas: imagens oficiais em inglês hospedadas pelo Limitless TCG
        abbr = ((detail.get(sid) or {}).get('abbreviation') or {}).get('official')
        if abbr and num.isdigit():
            add(c['id'], name, c.get('localId', ''),
                f'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/{abbr.upper()}/{abbr.upper()}_{int(num):03d}_R_EN_SM.png',
                'limitless-img')
            recovered += 1

    # coleções inteiras que não existem no TCGdex
    extra = 0
    for ps, sname in PTCG_EXTRA_SETS.items():
        data = _get_json(ses, 'https://api.pokemontcg.io/v2/cards', params={'q': f'set.id:{ps}', 'pageSize': 250})
        log(f'pokemontcg.io {ps}: {len((data or {}).get("data", []))} cartas')
        for c in (data or {}).get('data', []):
            try:
                n = int(re.sub(r'\D', '', c['number']) or 0)
            except ValueError:
                continue
            cid = f'{ps}-{n:03d}'
            if cid in seen:
                continue
            nm = c.get('name', '')
            m = re.match(r'Basic (\w+) Energy', nm)
            name = BASIC_PT.get(m.group(1), nm) if m else nm
            prices = (c.get('tcgplayer') or {}).get('prices') or {}
            usd = next((v.get('market') for v in prices.values() if v.get('market')), '')
            st = c.get('set') or {}
            img = (c.get('images') or {}).get('small')
            if not img:
                continue
            cards.append({'id': cid, 'name': name, 'local': f'{n:03d}', 'set': ps, 'set_name': sname,
                          'release': (st.get('releaseDate') or '').replace('/', '-'),
                          'official': st.get('printedTotal') or 0, 'img': img, 'src': 'ptcg', 'usd': usd or ''})
            seen.add(cid)
            extra += 1
        if not (data or {}).get('data'):
            # reserva: imagens oficiais hospedadas pelo Limitless TCG (energias básicas 1–8)
            rel = {'sve': '2023-03-31', 'mee': '2025-09-26'}.get(ps, '')
            for n, typ in enumerate(['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'], 1):
                cid = f'{ps}-{n:03d}'
                if cid in seen:
                    continue
                url = f'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/{ps.upper()}/{ps.upper()}_{n:03d}_R_EN_SM.png'
                cards.append({'id': cid, 'name': BASIC_PT[typ], 'local': f'{n:03d}', 'set': ps, 'set_name': sname,
                              'release': rel, 'official': 8, 'img': url, 'src': 'limitless', 'usd': ''})
                seen.add(cid)
                extra += 1
            log(f'{ps}: usando imagens do Limitless TCG')
    log(f'{len(pt)} cartas PT e {len(en)} EN na lista; {len(cards)} no banco '
        f'({sum(c["src"] == "en" for c in cards)} PT com imagem EN, {sum(c["src"] == "en-only" for c in cards)} só em inglês, '
        f'{recovered} sem imagem no TCGdex tentadas no pokemontcg.io, {extra} de coleções que faltam no TCGdex)')
    return cards


def write_meta(cards, path):
    """Dados das cartas do banco para o app (nome, coleção, número, data, imagem), em TSV."""
    def clean(v):
        return str(v if v is not None else '').replace('\t', ' ').replace('\n', ' ')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('id\tname\tset\tset_name\tlocal\tofficial\trelease\timage\tsrc\tusd\n')
        for c in cards:
            img = c['img']
            base = img[:-len('/low.webp')] if img.endswith('/low.webp') else img
            f.write('\t'.join(clean(x) for x in (c['id'], c['name'], c['set'], c['set_name'], c['local'],
                                                 c['official'], c['release'], base, c['src'], c['usd'])) + '\n')


def cache_path(cid):
    return os.path.join(CACHE, re.sub(r'[^A-Za-z0-9._-]', '_', cid) + '.webp')


def download_all(cards):
    os.makedirs(CACHE, exist_ok=True)
    ses = requests.Session()
    ad = requests.adapters.HTTPAdapter(pool_connections=48, pool_maxsize=48, max_retries=2)
    ses.mount('https://', ad)
    todo = [c for c in cards if not os.path.exists(cache_path(c['id']))]
    log(f'baixando {len(todo)} imagens (as outras {len(cards) - len(todo)} já estavam em cache)')

    def get(c):
        try:
            r = ses.get(c['img'], timeout=60)
            if r.status_code == 200 and len(r.content) > 500:
                with open(cache_path(c['id']), 'wb') as f:
                    f.write(r.content)
                return True
        except Exception:
            pass
        return False

    ok = 0
    with cf.ThreadPoolExecutor(40) as ex:
        for i, r in enumerate(ex.map(get, todo)):
            ok += r
            if i % 2000 == 0:
                log(f'  {i}/{len(todo)}')
    have = [c for c in cards if os.path.exists(cache_path(c['id']))]
    log(f'baixadas agora: {ok}; total com imagem: {len(have)}')
    return have


def load_native(cid):
    im = Image.open(cache_path(cid))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P'):
        im = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (128, 128, 128, 255))
        bg.alpha_composite(im)
        im = bg
    return np.asarray(im.convert('RGB'))


def load_card(cid):
    return cv2.resize(load_native(cid), (W, H), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------- distorções (foto simulada)

def augment(src, rng, neighbor=None):
    h, w = src.shape[:2]
    m = int(0.18 * w)
    ch, cw = h + 2 * m, w + 2 * m
    kind = rng.random()
    binder = neighbor is not None and kind >= 0.65
    if binder:
        # página de fichário: bolso escuro e pedaços das cartas vizinhas em volta
        bg = rng.uniform(15, 45) + rng.normal(0, 8, (ch, cw, 3))
        nb = cv2.resize(neighbor, (w, h))
        gap = int(rng.uniform(0.05, 0.12) * w)
        canvas0 = np.clip(bg, 0, 255).astype(np.uint8)
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            x0, y0 = m + dx * (w + gap), m + dy * (h + gap)
            xa, ya = max(0, x0), max(0, y0)
            xb, yb = min(cw, x0 + w), min(ch, y0 + h)
            if xb > xa and yb > ya:
                canvas0[ya:yb, xa:xb] = nb[ya - y0:yb - y0, xa - x0:xb - x0]
        bg = canvas0.astype(np.float32)
    elif kind < 0.4:
        col = rng.integers(0, 255, 3)
        bg = np.full((ch, cw, 3), col, np.float32) + rng.normal(0, 12, (ch, cw, 3))
    elif kind < 0.7:  # madeira/mesa: faixas
        base = rng.integers(60, 200, 3).astype(np.float32)
        yy = np.linspace(0, rng.uniform(5, 25), cw)
        stripes = (np.sin(yy)[None, :, None] * rng.uniform(5, 30))
        bg = np.broadcast_to(base, (ch, cw, 3)) + stripes + rng.normal(0, 6, (ch, cw, 3))
    else:  # escuro (teclado, tapete)
        bg = rng.uniform(10, 50) + rng.normal(0, 10, (ch, cw, 3))
    canvas = np.clip(bg, 0, 255).astype(np.uint8)
    canvas[m:m + h, m:m + w] = src
    pts = np.array([[m, m], [m + w, m], [m + w, m + h], [m, m + h]], np.float32)
    # erro de detecção da borda: cantos fora do lugar em até ~5%
    sig = rng.uniform(0.0, 0.025) * w
    noisy = pts + np.clip(rng.normal(0, sig, (4, 2)), -0.06 * w, 0.06 * w).astype(np.float32)
    if rng.random() < (0.45 if binder else 0.2):
        # recorte maior que a carta (moldura central / bolso do fichário): sobra borda e vizinhas
        e = rng.uniform(0.03, 0.14) * w
        noisy = noisy + np.array([[-e, -e], [e, -e], [e, e], [-e, e]], np.float32) * np.array([1, 88 / 63], np.float32)
    out = warp(canvas, noisy).astype(np.float32)
    # sleeve / plástico do fichário: véu claro (menos contraste) e faixas de brilho
    if binder or rng.random() < 0.35:
        haze = rng.uniform(0.05, 0.3)
        out = out * (1 - haze) + haze * rng.uniform(150, 230)
        for _ in range(int(rng.integers(1, 4))):
            band = np.zeros((H, W), np.float32)
            ang = rng.uniform(-60, 60)
            cx, cy = rng.uniform(0, W), rng.uniform(0, H)
            L = 2 * max(H, W)
            dx, dy = np.cos(np.radians(ang)) * L, np.sin(np.radians(ang)) * L
            cv2.line(band, (int(cx - dx), int(cy - dy)), (int(cx + dx), int(cy + dy)), 1.0, int(rng.uniform(4, 30)))
            band = cv2.GaussianBlur(band, (0, 0), rng.uniform(3, 12))
            a = rng.uniform(0.2, 0.7)
            out = out * (1 - a * band[..., None]) + 255 * a * band[..., None]
    # luz e cor
    out = out * rng.uniform(0.6, 1.25) + rng.uniform(-35, 35)
    out *= (1 + rng.normal(0, 0.07, 3))[None, None, :]
    out = 255 * (np.clip(out, 0, 255) / 255) ** rng.uniform(0.75, 1.35)
    # reflexo (brilho de luz na carta/sleeve)
    if rng.random() < 0.5:
        g = np.zeros((H, W), np.float32)
        cx, cy = int(rng.uniform(0, W)), int(rng.uniform(0, H))
        cv2.ellipse(g, (cx, cy), (int(rng.uniform(15, 90)), int(rng.uniform(10, 60))), rng.uniform(0, 180), 0, 360, 1.0, -1)
        g = cv2.GaussianBlur(g, (0, 0), rng.uniform(6, 20))
        a = rng.uniform(0.25, 0.75)
        out = out * (1 - a * g[..., None]) + 255 * a * g[..., None]
    # holográfico: arco-íris fraco
    if rng.random() < 0.25:
        xx = np.linspace(0, rng.uniform(3, 9), W)[None, :] + np.linspace(0, rng.uniform(2, 6), H)[:, None]
        rainbow = np.stack([np.sin(xx), np.sin(xx + 2.1), np.sin(xx + 4.2)], -1)
        out += rainbow * rng.uniform(8, 30)
    out = np.clip(out, 0, 255).astype(np.uint8)
    s = rng.uniform(0.0, 1.6)
    if s > 0.3:
        out = cv2.GaussianBlur(out, (0, 0), s)
    f = rng.uniform(0.35, 1.0)  # carta longe da câmera
    if f < 0.95:
        sm = cv2.resize(out, (max(16, int(W * f)), max(16, int(H * f))), interpolation=cv2.INTER_AREA)
        out = cv2.resize(sm, (W, H), interpolation=cv2.INTER_LINEAR)
    out = np.clip(out.astype(np.float32) + rng.normal(0, rng.uniform(0, 7), out.shape), 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, int(rng.uniform(40, 90))])
    return cv2.imdecode(enc, cv2.IMREAD_UNCHANGED)


# ---------------------------------------------------------------- negativos (não é carta)

def negatives(real_neg_imgs, rng, n=300):
    """Recortes que NÃO são cartas: fundo, teclado, pedaço de carta (arte interna), ruído."""
    out = []
    for k in range(n):
        kind = k % 3
        if kind == 0 and real_neg_imgs:
            img = real_neg_imgs[k % len(real_neg_imgs)]
            h0, w0 = img.shape[:2]
            cw = int(rng.uniform(0.3, 0.9) * w0)
            ch = int(cw * 88 / 63)
            ch = min(ch, h0 - 1)
            x = int(rng.uniform(0, w0 - cw))
            y = int(rng.uniform(0, h0 - ch))
            out.append(cv2.resize(img[y:y + ch, x:x + cw], (W, H), interpolation=cv2.INTER_AREA))
        elif kind == 1:
            base = rng.integers(0, 255, 3).astype(np.float32)
            g = np.broadcast_to(base, (H, W, 3)) + rng.normal(0, rng.uniform(5, 40), (H, W, 3))
            g = cv2.GaussianBlur(np.clip(g, 0, 255).astype(np.uint8), (0, 0), rng.uniform(0.5, 4))
            out.append(g)
        else:
            out.append(None)  # preenchido com pedaço de carta (precisa do banco)
    return out


# ---------------------------------------------------------------- modelos

def _regions(h, w, kind):
    import math
    r = [(0, h, 0, w)]
    if kind == 'full':
        r0, r1 = math.ceil(0.6 * h), math.floor(0.4 * h)
        c0, c1 = math.ceil(0.6 * w), math.floor(0.4 * w)
        r += [(0, r0, 0, c0), (0, r0, c1, w), (r1, h, 0, c0), (r1, h, c1, w)]
        r += [(0, math.ceil(0.4 * h), 0, w), (math.floor(0.3 * h), math.ceil(0.7 * h), 0, w), (math.floor(0.6 * h), h, 0, w)]
    else:
        r += [(0, h, 0, math.ceil(0.6 * w)), (0, h, math.floor(0.4 * w), w),
              (0, math.ceil(0.6 * h), 0, w), (math.floor(0.4 * h), h, 0, w)]
    return r


def make_feature_model(name):
    """Imagem W x H -> descritor regional (média por região do último mapa de características,
    cada região normalizada; regiões da carta inteira + da arte)."""
    import tensorflow as tf
    keras = tf.keras
    L = keras.layers
    kw = dict(include_top=False, weights='imagenet', input_shape=(None, None, 3), pooling=None)
    if name == 'mnv3l':
        bb = keras.applications.MobileNetV3Large(include_preprocessing=True, **kw)
    elif name == 'mnv3s':
        bb = keras.applications.MobileNetV3Small(include_preprocessing=True, **kw)
    elif name == 'effb0':
        bb = keras.applications.EfficientNetB0(**kw)
    else:
        raise ValueError(name)
    inp = keras.Input((H, W, 3), name='card')
    fmap = bb(inp)
    top, bot = round(ART[0] * H), H - round(ART[1] * H)
    left, right = round(ART[2] * W), W - round(ART[3] * W)
    art = L.Cropping2D(((top, bot), (left, right)))(inp)
    art = L.Resizing(ART_H, ART_W, interpolation='bilinear')(art)
    amap = bb(art)
    outs = []
    for m, kind in ((fmap, 'full'), (amap, 'art')):
        h, w = int(m.shape[1]), int(m.shape[2])
        for (a, b, c, d) in _regions(h, w, kind):
            v = L.Lambda(lambda t, a=a, b=b, c=c, d=d: tf.reduce_mean(t[:, a:b, c:d, :], axis=[1, 2]))(m)
            outs.append(L.UnitNormalization()(v))
    n_full = len(_regions(int(fmap.shape[1]), int(fmap.shape[2]), 'full'))
    model = keras.Model(inp, L.Concatenate()(outs), name=f'feat_{name}')
    C = int(fmap.shape[-1])
    log(f'[{name}] mapa {fmap.shape[1]}x{fmap.shape[2]}x{C}, arte {amap.shape[1]}x{amap.shape[2]}; '
        f'descritor {model.output_shape[-1]} ({n_full} regiões carta + {len(outs) - n_full} arte)')
    return model, n_full * C


def feats(model, imgs, bs=64):
    out = []
    for i in range(0, len(imgs), bs):
        out.append(np.asarray(model.predict_on_batch(np.asarray(imgs[i:i + bs], np.float32)), np.float32))
    return np.concatenate(out)


def l2n(x):
    return x / np.maximum(1e-8, np.linalg.norm(x, axis=1, keepdims=True))


def pca_basis(X, k, seed=0):
    from sklearn.utils.extmath import randomized_svd
    mean = X.mean(0)
    _, S, Vt = randomized_svd(X - mean, n_components=k, n_iter=4, random_state=seed)
    ev = (S ** 2) / len(X)
    return mean.astype(np.float32), Vt.T.astype(np.float32), ev.astype(np.float32)


def fit_projection(Xdb, Xa, ia, method):
    """Projeção D -> 256. 'pcaw': PCA com branqueamento. 'lw': branqueamento aprendido com pares
    (carta, foto simulada da mesma carta): esconde o que muda com luz/ângulo, realça o que distingue cartas."""
    k1 = min(1024, Xdb.shape[1], len(Xdb) - 1)
    mean, V1, ev = pca_basis(Xdb, k1 if method == 'lw' else DIM)
    if method == 'pcaw':
        P = V1 / np.sqrt(ev + ev[0] * 1e-3)[None, :]
        return mean, P.astype(np.float32)
    Zdb = (Xdb - mean) @ V1
    Za = (Xa - mean) @ V1
    D = Za - Zdb[ia]
    Sw = (D.T @ D) / len(D)
    Sw += np.eye(len(Sw), dtype=Sw.dtype) * (np.trace(Sw) / len(Sw)) * 0.05
    e, U = np.linalg.eigh(Sw.astype(np.float64))
    W1 = (U / np.sqrt(e)[None, :]) @ U.T
    Y = Zdb @ W1
    Y -= Y.mean(0)
    cov = (Y.T @ Y) / len(Y)
    e2, U2 = np.linalg.eigh(cov)
    V2 = U2[:, np.argsort(e2)[::-1][:DIM]]
    P = V1 @ W1 @ V2
    return mean, P.astype(np.float32)


def project(X, mean, P):
    return l2n((X - mean) @ P)


# ---------------------------------------------------------------- avaliação

LABELS = {
    'meowth-alola': lambda n: 'meowth' in n and 'alola' in n,
    'energia-escuridao': lambda n: ('energia' in n and ('escurid' in n or '{d}' in n)) or 'darkness energy' in n,
    'busca-de-energia': lambda n: 'busca de energia' in n or n == 'energy search',
}


def label_ok(label, name):
    if label in LABELS:
        return LABELS[label](name)
    words = label.split('-')
    return all(w in name.split() for w in words)


def real_queries():
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, 'real', '*.jpg'))):
        label = os.path.basename(f).split('__')[0]
        img = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        qs, _ = find_quads(img)
        gs = guide_quads(img.shape[1], img.shape[0])
        cands = [warp(img, q) for q in qs[:4]] + [warp(img, g) for g in gs]
        kinds = ['borda'] * len(qs[:4]) + ['centro'] * len(gs)
        out.append({'file': os.path.basename(f), 'label': label, 'img': img, 'cands': cands, 'kinds': kinds})
    return out


def evaluate(db, names, syn_q, syn_truth, real, real_q, neg_q):
    S = syn_q @ db.T
    top = np.argsort(-S, 1)[:, :5]
    t1 = top[:, 0]
    syn_scores = S[np.arange(len(S)), t1]
    correct = np.array([names[a] == names[b] for a, b in zip(t1, syn_truth)])
    neg = (neg_q @ db.T).max(1)
    # limiares: "min" deixa passar ~2% dos não-cartas; "strong" ~0,2%
    tmin = float(max(0.60, np.quantile(neg, 0.98)))  # piso de segurança
    tstrong = float(max(tmin + 0.08, np.quantile(neg, 0.998)))
    res = []
    for r, Q in zip(real, real_q):
        s = Q @ db.T
        best_c = int(np.argmax(s.max(1)))
        row = s[best_c]
        o = np.argsort(-row)[:5]
        other = next((row[j] for j in o[1:] if names[j] != names[o[0]]), row[o[1]])
        res.append({'file': r['file'], 'label': r['label'], 'cand': best_c, 'kind': r['kinds'][best_c],
                    'top': [int(j) for j in o], 'score': float(row[o[0]]), 'margin': float(row[o[0]] - other)})
    pos = [x for x in res if x['label'] != 'none']
    real_ok = float(np.mean([label_ok(x['label'], names[x['top'][0]]) for x in pos])) if pos else 0.0
    return {
        'syn_top1_id': float(np.mean(t1 == syn_truth)), 'syn_top1_name': float(correct.mean()),
        'syn_top5_id': float(np.mean([syn_truth[i] in top[i] for i in range(len(t1))])),
        'thr_min': tmin, 'thr_strong': tstrong,
        'syn_recall_min': float(np.mean(syn_scores >= tmin)), 'syn_recall_strong': float(np.mean(syn_scores >= tstrong)),
        'syn_precision_min': float(correct[syn_scores >= tmin].mean()) if (syn_scores >= tmin).any() else 0.0,
        'real_name_acc': real_ok, 'real_pos_scores': [round(x['score'], 3) for x in pos],
        'real_neg_scores': [round(x['score'], 3) for x in res if x['label'] == 'none'],
    }, res


# ---------------------------------------------------------------- exportação

def export_tflite(feat_model, mean, P, path, quant=True):
    import tensorflow as tf
    keras = tf.keras
    inp = keras.Input((H, W, 3), batch_size=1, name='card')
    x = feat_model(inp)
    d = keras.layers.Dense(DIM, name='proj')
    y = d(x)
    d.set_weights([P, (-mean @ P).astype(np.float32)])
    model = keras.Model(inp, y)
    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    if quant:  # pesos em float16: metade do tamanho, resultado praticamente igual
        conv.optimizations = [tf.lite.Optimize.DEFAULT]
        conv.target_spec.supported_types = [tf.float16]
    data = conv.convert()
    with open(path, 'wb') as f:
        f.write(data)


def tflite_embed(path, imgs):
    import tensorflow as tf
    it = tf.lite.Interpreter(model_path=path, num_threads=4)
    it.allocate_tensors()
    i0 = it.get_input_details()[0]['index']
    o0 = it.get_output_details()[0]['index']
    out = []
    for im in imgs:
        it.set_tensor(i0, np.asarray(im, np.float32)[None])
        it.invoke()
        out.append(it.get_tensor(o0)[0].copy())
    return l2n(np.array(out))


# ---------------------------------------------------------------- relatório visual

def contact(rows, path):
    tiles = []
    for left, right, text, ok in rows:
        t = np.hstack([cv2.resize(left, (W, H)), cv2.resize(right, (W, H))])
        t = cv2.copyMakeBorder(t, 0, 36, 0, 0, cv2.BORDER_CONSTANT, value=(20, 20, 20))
        cv2.putText(t, text[:52], (3, H + 14), 0, 0.42, (120, 255, 120) if ok else (255, 110, 110), 1)
        cv2.putText(t, text[52:104], (3, H + 30), 0, 0.42, (200, 200, 200), 1)
        tiles.append(t)
    if not tiles:
        return
    per = 4
    blank = np.zeros_like(tiles[0])
    grid = [np.hstack(tiles[i:i + per] + [blank] * (per - len(tiles[i:i + per]))) for i in range(0, len(tiles), per)]
    cv2.imwrite(path, cv2.cvtColor(np.vstack(grid), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])


_ALL_IDS = []


def _aug_job(args):
    cid, seed = args
    rng = np.random.default_rng(seed)
    nb = load_native(_ALL_IDS[int(rng.integers(len(_ALL_IDS)))]) if _ALL_IDS and rng.random() < 0.4 else None
    return augment(load_native(cid), rng, nb)


# ---------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--eval', action='store_true', help='testa várias redes/projeções e escolhe a melhor')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--nsyn', type=int, default=1500)
    ap.add_argument('--naug', type=int, default=2, help='fotos simuladas por carta para aprender a projeção')
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    cfg = json.load(open(os.path.join(ROOT, 'config.json')))

    cards = download_all(fetch_cards())
    if args.limit:
        cards = cards[:args.limit]
    ids = [c['id'] for c in cards]
    names = [norm_name(c['name']) for c in cards]
    N = len(cards)
    for lab, fn in LABELS.items():
        hits = [f'{ids[i]}' for i in range(N) if fn(names[i])]
        log(f'banco tem {len(hits)} cartas para "{lab}": {hits[:30]}')

    import multiprocessing as mp
    _ALL_IDS[:] = ids  # vizinhas no fichário simulado (antes de criar os processos)
    pool = mp.Pool(max(1, os.cpu_count() or 2))
    rng = np.random.default_rng(7)
    syn_idx = rng.choice(N, size=min(args.nsyn, N), replace=False)
    syn_imgs = pool.map(_aug_job, [(ids[i], 1000 + k) for k, i in enumerate(syn_idx)], chunksize=32)
    ia = np.repeat(np.arange(N), args.naug)
    aug_imgs_jobs = [(ids[i], 10_000_000 + k) for k, i in enumerate(ia)]
    real = real_queries()
    neg_imgs = negatives([r['img'] for r in real if r['label'] == 'none'], rng)
    # pedaços de carta não entram: um pedaço da carta X bater com X é acerto, não falso positivo
    neg_imgs = [x for x in neg_imgs if x is not None]
    log(f'{len(syn_imgs)} fotos simuladas p/ teste, {len(ia)} p/ treino, {len(neg_imgs)} negativos, {len(real)} fotos reais')

    backbones = ['mnv3s', 'mnv3l'] if args.eval else [cfg['backbone']]
    modes = ['full', 'cat'] if args.eval else [cfg['mode']]
    methods = ['pcaw', 'lw'] if args.eval else [cfg['method']]

    table = []
    best = None
    models = {}
    for b in backbones:
        fm, n_full = make_feature_model(b)
        models[b] = fm
        log(f'[{b}] banco…')
        Xdb = []
        for i in range(0, N, 512):
            Xdb.append(feats(fm, [load_card(cid) for cid in ids[i:i + 512]]).astype(np.float16))
        Xdb = np.concatenate(Xdb)
        log(f'[{b}] fotos simuladas de treino…')
        Xa = []
        for i in range(0, len(aug_imgs_jobs), 1024):
            imgs = pool.map(_aug_job, aug_imgs_jobs[i:i + 1024], chunksize=16)
            Xa.append(feats(fm, imgs).astype(np.float16))
        Xa = np.concatenate(Xa)
        Xs = feats(fm, syn_imgs)
        Xn = feats(fm, neg_imgs)
        Xr = [feats(fm, r['cands']) for r in real]
        log(f'[{b}] características prontas ({Xdb.shape[1]} dims)')
        for mode in modes:
            sl = slice(0, n_full) if mode == 'full' else slice(None)
            for method in methods:
                mean, P = fit_projection(Xdb[:, sl].astype(np.float32), Xa[:, sl].astype(np.float32), ia, method)
                db = project(Xdb[:, sl].astype(np.float32), mean, P)
                m, res = evaluate(db, names, project(Xs[:, sl], mean, P), syn_idx, real,
                                  [project(x[:, sl], mean, P) for x in Xr], project(Xn[:, sl], mean, P))
                m.update({'backbone': b, 'mode': mode, 'method': method})
                table.append(m)
                log(f'  {b:6s} {mode:4s} {method:4s} sint: id {m["syn_top1_id"]:.3f} nome {m["syn_top1_name"]:.3f} '
                    f'top5 {m["syn_top5_id"]:.3f} | lim {m["thr_min"]:.2f}/{m["thr_strong"]:.2f} '
                    f'recall {m["syn_recall_min"]:.2f}/{m["syn_recall_strong"]:.2f} prec {m["syn_precision_min"]:.3f} | '
                    f'reais {m["real_name_acc"]:.2f} pos {m["real_pos_scores"]} neg {m["real_neg_scores"]}')
                key = (m['real_name_acc'] + m['syn_top1_name'], m['syn_recall_min'])
                if best is None or key > best[0]:
                    best = (key, b, mode, method, mean, P, db, res, project(Xs[:, sl], mean, P), m, sl)
        del Xa
    pool.close()

    _, b, mode, method, mean, P, db, res, sq, bm, sl = best
    log(f'ESCOLHIDO: {b} {mode} {method}')
    json.dump({'backbone': b, 'mode': mode, 'method': method}, open(os.path.join(OUT, 'chosen.json'), 'w'))
    json.dump({'table': table, 'real': [{**x, 'top_ids': [ids[j] for j in x['top']],
                                         'top_names': [names[j] for j in x['top']]} for x in res]},
              open(os.path.join(OUT, 'report.json'), 'w'), indent=1)

    rows = []
    for r, x in zip(real, res):
        t = x['top'][0]
        ok = x['label'] != 'none' and label_ok(x['label'], names[t])
        rows.append((r['cands'][x['cand']], load_card(ids[t]),
                     f"{r['file'][:20]} {x['kind']} {x['score']:.3f} m{x['margin']:.3f} -> {ids[t]} {names[t]}", ok))
    contact(rows, os.path.join(OUT, 'report_real.jpg'))
    S = sq @ db.T
    t1 = S.argmax(1)
    wrong = [k for k in range(len(t1)) if names[t1[k]] != names[syn_idx[k]]][:24]
    contact([(syn_imgs[k], load_card(ids[t1[k]]), f'{ids[syn_idx[k]]} -> {ids[t1[k]]} {S[k, t1[k]]:.3f} {names[t1[k]]}', False)
             for k in wrong], os.path.join(OUT, 'report_syn_errors.jpg'))

    # exportação: o modelo "inteiro" (rede + regiões + projeção) num .tflite
    fm = models[b]
    if mode == 'full':
        # zera a parte da arte na projeção (o modelo exportado calcula as duas, mas só usa a da carta)
        Pfull = np.zeros((fm.output_shape[-1], DIM), np.float32)
        Pfull[sl] = P
        mfull = np.zeros(fm.output_shape[-1], np.float32)
        mfull[sl] = mean
        P, mean = Pfull, mfull
    tfl = os.path.join(OUT, 'model.tflite')
    sel = list(range(0, N, max(1, N // 24)))[:24]
    chk = [load_card(ids[i]) for i in sel]
    for quant in (True, False):
        export_tflite(fm, mean, P, tfl, quant)
        cos = (tflite_embed(tfl, chk) * db[sel]).sum(1)
        log(f'tflite (float16={quant}) x keras: cosseno mín {cos.min():.4f}; {os.path.getsize(tfl) / 1e6:.1f} MB')
        if cos.min() > 0.985:
            break
    db.astype('<f2').tofile(os.path.join(OUT, 'emb.f16'))
    with open(os.path.join(OUT, 'ids.txt'), 'w') as f:
        f.write('\n'.join(ids))
    write_meta(cards, os.path.join(OUT, 'cards.tsv'))
    version = time.strftime('%Y%m%d') + '-' + os.environ.get('GITHUB_RUN_NUMBER', 'local')
    manifest = {'version': version, 'count': N, 'dim': DIM, 'w': W, 'h': H, 'backbone': b, 'mode': mode,
                'method': method, 'tflite_cos_min': float(cos.min()),
                'thresholds': {'min': round(bm['thr_min'], 3), 'strong': round(bm['thr_strong'], 3)},
                'metrics': bm, 'files': {'model': 'model.tflite', 'emb': 'emb.f16', 'ids': 'ids.txt', 'meta': 'cards.tsv'}}
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    log('fim')


if __name__ == '__main__':
    main()
