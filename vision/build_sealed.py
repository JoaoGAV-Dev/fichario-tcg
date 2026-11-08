"""Banco de PRODUTOS LACRADOS (ETB, booster, box, blister, lata, caixa de booster…) para o reconhecimento.

Fonte: tcgcsv.com — espelho diário e público do catálogo do TCGplayer, sem chave:
  categoria 3 = Pokémon em inglês, categoria 85 = Pokémon japonês. Traz foto, coleção e preço de mercado (US$).
Produtos em português têm a mesma arte do inglês; o app diferencia pelo texto da embalagem (OCR).

Saída (release "sealed-db"): sealed.tflite (rede + projeção), sealed.f16 (vetores), sealed.tsv (dados), manifest.json.
"""
import argparse
import concurrent.futures as cf
import json
import multiprocessing as mp
import os
import re
import sys
import time

os.environ.setdefault('TF_USE_LEGACY_KERAS', '1')
import cv2  # noqa: E402
import numpy as np  # noqa: E402
import requests  # noqa: E402
from PIL import Image  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
import build_db as B  # noqa: E402

S = 256  # entrada quadrada
DIM = 256
CACHE = os.path.join(B.ROOT, '..', 'cache', 'sealed')
UA = {'User-Agent': 'FicharioTCG/1.0 (+https://github.com/JoaoGAV-Dev/fichario-tcg)'}

# tipo do produto (para mostrar no app) — ordem importa
TYPES = [
    (r'pok[eé]mon center elite trainer box', 'ETB Pokémon Center'),
    (r'elite trainer box', 'Treinador Avançado (ETB)'),
    (r'booster box|booster display', 'Caixa de Booster'),
    (r'booster bundle|bundle', 'Pacote de Boosters'),
    (r'build (&|and) battle stadium', 'Estádio Monte e Batalhe'),
    (r'build (&|and) battle', 'Kit Monte e Batalhe'),
    (r'blister|checklane', 'Blister'),
    (r'(sleeved )?booster pack|\bpack\b', 'Booster'),
    (r'\btin\b', 'Lata'),
    (r'premium collection|ultra[- ]premium', 'Coleção Premium'),
    (r'collection|box', 'Box / Coleção'),
    (r'deck', 'Deck'),
    (r'binder|portfolio', 'Fichário'),
]
SKIP = re.compile(r'\bcase\b|code card|sleeves?$|playmat|deck box|card sleeves|dice|coin\b|pin\b|figure|plush|'
                  r'\bdisplay case\b|online code', re.I)


def ptype(name):
    n = name.lower()
    for rx, t in TYPES:
        if re.search(rx, n):
            return t
    return 'Produto lacrado'


def fetch_products():
    ses = requests.Session()
    ses.headers.update(UA)
    out = []
    for cat, lang in ((3, 'EN'), (85, 'JP')):
        groups = B._get_json(ses, f'https://tcgcsv.com/tcgplayer/{cat}/groups') or {}
        groups = groups.get('results', [])
        B.log(f'tcgcsv categoria {cat} ({lang}): {len(groups)} coleções')

        def one(g):
            gid = g['groupId']
            p = B._get_json(ses, f'https://tcgcsv.com/tcgplayer/{cat}/{gid}/products') or {}
            pr = B._get_json(ses, f'https://tcgcsv.com/tcgplayer/{cat}/{gid}/prices') or {}
            price = {}
            for x in pr.get('results', []):
                v = x.get('marketPrice') or x.get('midPrice')
                if v:
                    price[x['productId']] = max(price.get(x['productId'], 0), v)
            rows = []
            for x in p.get('results', []):
                ext = {e.get('name'): e.get('value') for e in (x.get('extendedData') or [])}
                if 'Number' in ext or 'Rarity' in ext:
                    continue  # é carta avulsa
                name = x.get('name', '')
                if not name or SKIP.search(name) or not x.get('imageUrl'):
                    continue
                rows.append({'id': f'{lang.lower()}-{x["productId"]}', 'pid': x['productId'], 'name': name, 'lang': lang,
                             'type': ptype(name), 'set': g.get('name', ''), 'abbr': g.get('abbreviation') or '',
                             'release': (g.get('publishedOn') or '')[:10],
                             'img': x['imageUrl'].replace('_200w', '_400w'), 'img_small': x['imageUrl'],
                             'usd': price.get(x['productId'], '')})
            return rows

        with cf.ThreadPoolExecutor(12) as ex:
            for rows in ex.map(one, groups):
                out.extend(rows)
    B.log(f'{len(out)} produtos lacrados ({sum(r["lang"] == "EN" for r in out)} EN, {sum(r["lang"] == "JP" for r in out)} JP)')
    return out


def cpath(pid):
    return os.path.join(CACHE, re.sub(r'[^A-Za-z0-9._-]', '_', pid) + '.jpg')


def download(prods):
    os.makedirs(CACHE, exist_ok=True)
    ses = requests.Session()
    ses.headers.update(UA)
    ses.mount('https://', requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=2))
    todo = [p for p in prods if not os.path.exists(cpath(p['id']))]
    B.log(f'baixando {len(todo)} fotos de produto')

    def get(p):
        for url in (p['img'], p['img_small']):
            try:
                r = ses.get(url, timeout=60)
                if r.status_code == 200 and len(r.content) > 1500:
                    open(cpath(p['id']), 'wb').write(r.content)
                    return
            except Exception:
                pass
    with cf.ThreadPoolExecutor(32) as ex:
        list(ex.map(get, todo))
    have = [p for p in prods if os.path.exists(cpath(p['id']))]
    B.log(f'{len(have)} produtos com foto')
    return have


def load_prod(pid):
    """Foto do produto em quadrado S×S (fundo branco, como vem do TCGplayer)."""
    im = Image.open(cpath(pid))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P'):
        im = im.convert('RGBA')
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    a = np.asarray(im.convert('RGB'))
    h, w = a.shape[:2]
    side = max(h, w)
    canvas = np.full((side, side, 3), 255, np.uint8)
    canvas[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = a
    return cv2.resize(canvas, (S, S), interpolation=cv2.INTER_AREA)


def _mask_product(img):
    """Separa o produto do fundo branco da foto."""
    g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    m = (g < 245).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return cv2.GaussianBlur(m, (5, 5), 0).astype(np.float32) / 255


def augment_prod(img, rng, other=None):
    """Simula a foto do celular: produto inclinado, sobre mesa/estante, luz, reflexo do plástico, recorte imperfeito."""
    m = _mask_product(img)
    # fundo: cor, mesa, ou outro produto ao lado (estante)
    k = rng.random()
    if k < 0.35:
        bg = np.full((S, S, 3), rng.integers(0, 255, 3), np.float32) + rng.normal(0, 10, (S, S, 3))
    elif k < 0.65 or other is None:
        base = rng.integers(40, 200, 3).astype(np.float32)
        bg = np.broadcast_to(base, (S, S, 3)) + (np.sin(np.linspace(0, rng.uniform(4, 20), S))[None, :, None] * 20)
        bg = bg + rng.normal(0, 6, (S, S, 3))
    else:
        bg = cv2.resize(other, (S, S)).astype(np.float32) * rng.uniform(0.5, 1.0)
    comp = img.astype(np.float32) * m[..., None] + bg * (1 - m[..., None])
    # perspectiva (produto girado/inclinado) + escala + deslocamento
    sc = rng.uniform(0.6, 1.05)
    d = S * 0.5
    src = np.float32([[0, 0], [S, 0], [S, S], [0, S]])
    jitter = rng.normal(0, S * 0.06, (4, 2)).astype(np.float32)
    c = np.float32([d + rng.normal(0, S * 0.06), d + rng.normal(0, S * 0.06)])
    dst = (src - d) * sc + c + jitter
    M = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    border = bg.mean((0, 1))
    out = cv2.warpPerspective(comp, M, (S, S), borderMode=cv2.BORDER_CONSTANT, borderValue=tuple(float(x) for x in border))
    # luz, cor
    out = out * rng.uniform(0.6, 1.25) + rng.uniform(-30, 30)
    out *= (1 + rng.normal(0, 0.07, 3))[None, None, :]
    # plástico (filme do lacre): faixas de brilho
    if rng.random() < 0.6:
        for _ in range(int(rng.integers(1, 4))):
            band = np.zeros((S, S), np.float32)
            ang = rng.uniform(-70, 70)
            cx, cy = rng.uniform(0, S), rng.uniform(0, S)
            L = 2 * S
            dx, dy = np.cos(np.radians(ang)) * L, np.sin(np.radians(ang)) * L
            cv2.line(band, (int(cx - dx), int(cy - dy)), (int(cx + dx), int(cy + dy)), 1.0, int(rng.uniform(5, 40)))
            band = cv2.GaussianBlur(band, (0, 0), rng.uniform(4, 14))
            a = rng.uniform(0.2, 0.7)
            out = out * (1 - a * band[..., None]) + 255 * a * band[..., None]
    out = np.clip(out, 0, 255).astype(np.uint8)
    s = rng.uniform(0, 1.8)
    if s > 0.3:
        out = cv2.GaussianBlur(out, (0, 0), s)
    f = rng.uniform(0.4, 1.0)
    if f < 0.95:
        out = cv2.resize(cv2.resize(out, (int(S * f), int(S * f)), interpolation=cv2.INTER_AREA), (S, S))
    ok, enc = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, int(rng.uniform(45, 90))])
    return cv2.imdecode(enc, cv2.IMREAD_UNCHANGED)


_IDS = []


def _job(a):
    pid, seed = a
    rng = np.random.default_rng(seed)
    other = load_prod(_IDS[int(rng.integers(len(_IDS)))]) if _IDS and rng.random() < 0.3 else None
    return augment_prod(load_prod(pid), rng, other)


def make_model(name):
    import tensorflow as tf
    keras = tf.keras
    L = keras.layers
    kw = dict(include_top=False, weights='imagenet', input_shape=(S, S, 3), include_preprocessing=True)
    bb = (keras.applications.MobileNetV3Large if name == 'mnv3l' else keras.applications.MobileNetV3Small)(**kw)
    inp = keras.Input((S, S, 3), name='product')
    fmap = bb(inp)
    h, w = int(fmap.shape[1]), int(fmap.shape[2])
    regions = [(0, h, 0, w)]
    for i in range(3):  # grade 3×3 com sobreposição
        for j in range(3):
            regions.append((int(i * h / 4), int((i + 2) * h / 4), int(j * w / 4), int((j + 2) * w / 4)))
    outs = []
    for (a, b, c, d) in regions:
        v = L.Lambda(lambda t, a=a, b=b, c=c, d=d: tf.reduce_mean(t[:, a:b, c:d, :], axis=[1, 2]))(fmap)
        outs.append(L.UnitNormalization()(v))
    return keras.Model(inp, L.Concatenate()(outs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--naug', type=int, default=3)
    ap.add_argument('--backbone', default='mnv3s')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    os.makedirs(B.OUT, exist_ok=True)
    prods = download(fetch_products())
    if args.limit:
        prods = prods[:args.limit]
    ids = [p['id'] for p in prods]
    N = len(ids)
    _IDS[:] = ids
    pool = mp.Pool(max(1, os.cpu_count() or 2))
    rng = np.random.default_rng(3)
    test_idx = rng.choice(N, size=min(1200, N), replace=False)
    test_imgs = pool.map(_job, [(ids[i], 500_000 + k) for k, i in enumerate(test_idx)], chunksize=16)
    ia = np.repeat(np.arange(N), args.naug)
    jobs = [(ids[i], 9_000_000 + k) for k, i in enumerate(ia)]
    # negativos: fundos e cartas avulsas (não são produto)
    neg = []
    for k in range(200):
        r2 = np.random.default_rng(77 + k)
        bgc = r2.integers(0, 255, 3).astype(np.float32)
        g = np.broadcast_to(bgc, (S, S, 3)) + r2.normal(0, r2.uniform(5, 40), (S, S, 3))
        neg.append(cv2.GaussianBlur(np.clip(g, 0, 255).astype(np.uint8), (0, 0), r2.uniform(0.5, 4)))

    import tensorflow as tf  # noqa: F401 (depois de criar os processos)
    fm = make_model(args.backbone)
    B.log(f'descritor {fm.output_shape[-1]} dims; {N} produtos')
    Xdb = np.concatenate([B.feats(fm, [load_prod(p) for p in ids[i:i + 512]]).astype(np.float16) for i in range(0, N, 512)])
    Xa = []
    for i in range(0, len(jobs), 1024):
        Xa.append(B.feats(fm, pool.map(_job, jobs[i:i + 1024], chunksize=16)).astype(np.float16))
    Xa = np.concatenate(Xa)
    Xt = B.feats(fm, test_imgs)
    Xn = B.feats(fm, neg)
    pool.close()
    B.log('características prontas')
    best = None
    for method in ('pcaw', 'lw'):
        mean, P = B.fit_projection(Xdb.astype(np.float32), Xa.astype(np.float32), ia, method)
        db = B.project(Xdb.astype(np.float32), mean, P)
        q = B.project(Xt, mean, P)
        sc = q @ db.T
        t1 = sc.argmax(1)
        acc = float(np.mean(t1 == test_idx))
        # mesmo produto em outra língua/variação conta como "quase"
        same_name = float(np.mean([re.sub(r'\W', '', prods[a]['name'].lower()) == re.sub(r'\W', '', prods[b]['name'].lower())
                                   for a, b in zip(t1, test_idx)]))
        top5 = float(np.mean([test_idx[i] in np.argsort(-sc[i])[:5] for i in range(len(t1))]))
        negs = (B.project(Xn, mean, P) @ db.T).max(1)
        tmin = float(max(0.55, np.quantile(negs, 0.98)))
        top_s = sc.max(1)
        B.log(f'{method}: acerto {acc:.3f} (mesmo nome {same_name:.3f}) top5 {top5:.3f} | limiar {tmin:.2f} '
              f'recall {np.mean(top_s >= tmin):.2f}')
        if best is None or acc > best[0]:
            best = (acc, method, mean, P, db, tmin, top5)
    acc, method, mean, P, db, tmin, top5 = best

    # exportação
    import tensorflow as tf
    keras = tf.keras
    inp = keras.Input((S, S, 3), batch_size=1, name='product')
    d = keras.layers.Dense(DIM, name='proj')
    y = d(fm(inp))
    d.set_weights([P, (-mean @ P).astype(np.float32)])
    model = keras.Model(inp, y)
    path = os.path.join(B.OUT, 'sealed.tflite')
    sel = list(range(0, N, max(1, N // 16)))[:16]
    for quant in (True, False):
        conv = tf.lite.TFLiteConverter.from_keras_model(model)
        if quant:
            conv.optimizations = [tf.lite.Optimize.DEFAULT]
            conv.target_spec.supported_types = [tf.float16]
        open(path, 'wb').write(conv.convert())
        cos = (B.tflite_embed(path, [load_prod(ids[i]) for i in sel]) * db[sel]).sum(1)
        B.log(f'tflite (float16={quant}): cosseno mín {cos.min():.4f}')
        if cos.min() > 0.985:
            break
    db.astype('<f2').tofile(os.path.join(B.OUT, 'sealed.f16'))
    with open(os.path.join(B.OUT, 'sealed.tsv'), 'w', encoding='utf-8') as f:
        f.write('id\tname\tlang\ttype\tset\tabbr\trelease\timage\tusd\n')
        for p in prods:
            f.write('\t'.join(str(p[k]).replace('\t', ' ') for k in
                              ('id', 'name', 'lang', 'type', 'set', 'abbr', 'release', 'img_small', 'usd')) + '\n')
    version = time.strftime('%Y%m%d') + '-' + os.environ.get('GITHUB_RUN_NUMBER', 'local')
    json.dump({'version': version, 'count': N, 'dim': DIM, 'size': S, 'method': method,
               'thresholds': {'min': round(tmin, 3), 'strong': round(tmin + 0.1, 3)},
               'metrics': {'acc': acc, 'top5': top5},
               'files': {'model': 'sealed.tflite', 'emb': 'sealed.f16', 'ids': 'sealed_ids.txt', 'meta': 'sealed.tsv'}},
              open(os.path.join(B.OUT, 'sealed_manifest.json'), 'w'), indent=1)
    open(os.path.join(B.OUT, 'sealed_ids.txt'), 'w').write('\n'.join(ids))
    # amostra visual: fotos simuladas x produto encontrado
    rows = []
    q = B.project(Xt, mean, P)
    t1 = (q @ db.T).argmax(1)
    for k in range(min(16, len(test_idx))):
        rows.append((cv2.resize(test_imgs[k], (B.W, B.H)), cv2.resize(load_prod(ids[t1[k]]), (B.W, B.H)),
                     f'{prods[test_idx[k]]["name"][:24]} -> {prods[t1[k]]["name"][:24]}', t1[k] == test_idx[k]))
    B.contact(rows, os.path.join(B.OUT, 'sealed_report.jpg'))
    B.log('fim')


if __name__ == '__main__':
    main()
