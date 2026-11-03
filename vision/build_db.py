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

import cv2
import numpy as np
import requests
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from cardvision import ART, ART_H, ART_W, H, W, find_quads, warp  # noqa: E402

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

def fetch_cards():
    ses = requests.Session()
    pt = ses.get('https://api.tcgdex.net/v2/pt/cards', timeout=180).json()
    en = ses.get('https://api.tcgdex.net/v2/en/cards', timeout=180).json()
    en_img = {c['id']: c.get('image') for c in en if c.get('image')}
    cards = []
    for c in pt:
        img = c.get('image')
        src = 'pt'
        if not img:
            img = en_img.get(c['id'])
            src = 'en'
        if not img or '/tcgp/' in img:
            continue
        cards.append({'id': c['id'], 'name': c.get('name', ''), 'img': img + '/low.webp', 'src': src})
    log(f'{len(pt)} cartas PT na lista; {len(cards)} com imagem ({sum(c["src"] == "en" for c in cards)} usando a imagem em inglês)')
    return cards


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

def augment(src, rng):
    h, w = src.shape[:2]
    m = int(0.18 * w)
    ch, cw = h + 2 * m, w + 2 * m
    kind = rng.random()
    if kind < 0.4:
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
    out = warp(canvas, noisy).astype(np.float32)
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


# ---------------------------------------------------------------- modelos

def make_feature_model(name):
    import keras
    from keras import layers
    if name == 'mnv3l':
        bb = keras.applications.MobileNetV3Large(include_top=False, weights='imagenet', input_shape=(None, None, 3),
                                                 pooling='avg', include_preprocessing=True)
    elif name == 'mnv3s':
        bb = keras.applications.MobileNetV3Small(include_top=False, weights='imagenet', input_shape=(None, None, 3),
                                                 pooling='avg', include_preprocessing=True)
    elif name == 'effb0':
        bb = keras.applications.EfficientNetB0(include_top=False, weights='imagenet', input_shape=(None, None, 3),
                                               pooling='avg')
    else:
        raise ValueError(name)
    inp = keras.Input((H, W, 3), batch_size=None, name='card')
    full = bb(inp)
    top, bot = round(ART[0] * H), H - round(ART[1] * H)
    left, right = round(ART[2] * W), W - round(ART[3] * W)
    art = layers.Cropping2D(((top, bot), (left, right)))(inp)
    art = layers.Resizing(ART_H, ART_W, interpolation='bilinear')(art)
    artf = bb(art)
    return keras.Model(inp, [full, artf], name=f'feat_{name}')


def feats(model, imgs, bs=64):
    fa, fb = [], []
    for i in range(0, len(imgs), bs):
        a, b = model.predict_on_batch(np.asarray(imgs[i:i + bs], np.float32))
        fa.append(np.asarray(a))
        fb.append(np.asarray(b))
    return np.concatenate(fa), np.concatenate(fb)


def l2n(x):
    return x / np.maximum(1e-8, np.linalg.norm(x, axis=1, keepdims=True))


def combine(full, art, mode):
    if mode == 'full':
        return full
    if mode == 'art':
        return art
    return np.concatenate([l2n(full), l2n(art)], 1) if mode == 'cat' else None


def fit_pca(X, white):
    mean = X.mean(0)
    Xc = X - mean
    cov = (Xc.T @ Xc) / len(X)
    ev, V = np.linalg.eigh(cov)
    idx = np.argsort(ev)[::-1][:DIM]
    ev, V = ev[idx], V[:, idx]
    P = V / np.sqrt(ev + ev[0] * 1e-3)[None, :] if white else V
    return mean.astype(np.float32), P.astype(np.float32)


def project(X, mean, P):
    return l2n((X - mean) @ P)


# ---------------------------------------------------------------- avaliação

LABELS = {
    'meowth-alola': lambda n: 'meowth' in n and 'alola' in n,
    'energia-escuridao': lambda n: ('escurid' in n or '{d}' in n or 'darkness' in n) and 'energia' in n,
    'busca-de-energia': lambda n: 'busca de energia' in n,
}


def real_queries():
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, 'real', '*.jpg'))):
        label = os.path.basename(f).split('__')[0]
        img = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        qs, g = find_quads(img)
        cands = [warp(img, q) for q in qs] + [warp(img, g)]
        kinds = ['borda'] * len(qs) + ['centro']
        out.append({'file': os.path.basename(f), 'label': label, 'cands': cands, 'kinds': kinds})
    return out


def evaluate(db, names, syn_q, syn_truth, real, real_q):
    """db: N x D normalizado. syn_q: M x D. real_q: lista (por foto) de matrizes (candidatos x D)."""
    S = syn_q @ db.T
    top = np.argsort(-S, 1)[:, :5]
    t1 = top[:, 0]
    id_ok = float(np.mean(t1 == syn_truth))
    name_ok = float(np.mean([names[a] == names[b] for a, b in zip(t1, syn_truth)]))
    top5 = float(np.mean([syn_truth[i] in top[i] for i in range(len(t1))]))
    srt = np.sort(S, 1)
    syn_scores = srt[:, -1]
    res = []
    for r, Q in zip(real, real_q):
        s = Q @ db.T
        best_c = int(np.argmax(s.max(1)))
        row = s[best_c]
        o = np.argsort(-row)[:5]
        # "margem": melhor nota menos a melhor nota de OUTRO nome
        other = next((row[j] for j in o[1:] if names[j] != names[o[0]]), row[o[1]])
        res.append({'file': r['file'], 'label': r['label'], 'cand': best_c, 'kind': r['kinds'][best_c],
                    'top': [int(j) for j in o], 'score': float(row[o[0]]), 'margin': float(row[o[0]] - other)})
    pos = [x for x in res if x['label'] in LABELS]
    real_ok = float(np.mean([LABELS[x['label']](names[x['top'][0]]) for x in pos])) if pos else 0.0
    neg = [x['score'] for x in res if x['label'] == 'none']
    return {'syn_top1_id': id_ok, 'syn_top1_name': name_ok, 'syn_top5_id': top5,
            'syn_score_p10': float(np.percentile(syn_scores, 10)),
            'real_name_acc': real_ok, 'real_pos_scores': [round(x['score'], 3) for x in pos],
            'real_neg_scores': [round(s, 3) for s in neg]}, res


# ---------------------------------------------------------------- exportação

def export_tflite(feat_model, mode, mean, P, path, quant=True):
    import keras
    import tensorflow as tf
    from keras import layers
    inp = keras.Input((H, W, 3), batch_size=1, name='card')
    full, art = feat_model(inp)
    if mode == 'full':
        x = full
    elif mode == 'art':
        x = art
    else:
        x = layers.Concatenate()([layers.UnitNormalization()(full), layers.UnitNormalization()(art)])
    d = layers.Dense(DIM, name='pca')
    y = d(x)
    d.set_weights([P, (-mean @ P).astype(np.float32)])
    model = keras.Model(inp, y)

    @tf.function(input_signature=[tf.TensorSpec([1, H, W, 3], tf.float32)])
    def serve(x):
        return model(x, training=False)

    conv = tf.lite.TFLiteConverter.from_concrete_functions([serve.get_concrete_function()], model)
    if quant:
        conv.optimizations = [tf.lite.Optimize.DEFAULT]  # pesos em 8 bits: modelo ~4x menor
    data = conv.convert()
    with open(path, 'wb') as f:
        f.write(data)
    return model


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


# ---------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--eval', action='store_true', help='testa várias redes/recortes e escolhe a melhor')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--nsyn', type=int, default=1500)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    cfg = json.load(open(os.path.join(ROOT, 'config.json')))

    cards = download_all(fetch_cards())
    if args.limit:
        cards = cards[:args.limit]
    ids = [c['id'] for c in cards]
    names = [norm_name(c['name']) for c in cards]
    N = len(cards)
    log('nomes de energia de escuridão no banco:', sorted({n for n in names if 'escurid' in n})[:12])

    rng = np.random.default_rng(7)
    syn_idx = rng.choice(N, size=min(args.nsyn, N), replace=False)
    syn_imgs = []
    for k, i in enumerate(syn_idx):
        syn_imgs.append(augment(load_native(ids[i]), np.random.default_rng(1000 + k)))
    real = real_queries()
    log(f'{len(syn_imgs)} fotos simuladas, {len(real)} fotos reais')

    backbones = ['mnv3l', 'effb0', 'mnv3s'] if args.eval else [cfg['backbone']]
    modes = ['full', 'art', 'cat'] if args.eval else [cfg['mode']]
    whites = [False, True] if args.eval else [cfg['white']]

    table = []
    best = None
    cache_feats = {}
    for b in backbones:
        fm = make_feature_model(b)
        log(f'[{b}] extraindo características de {N} cartas…')
        dbf, dba = [], []
        for i in range(0, N, 512):
            batch = [load_card(cid) for cid in ids[i:i + 512]]
            a, c = feats(fm, batch)
            dbf.append(a)
            dba.append(c)
            if i % 4096 == 0:
                log(f'  {i}/{N}')
        dbf, dba = np.concatenate(dbf), np.concatenate(dba)
        sqf, sqa = feats(fm, syn_imgs)
        rq = [feats(fm, r['cands']) for r in real]
        log(f'[{b}] pronto ({dbf.shape[1]} dims)')
        for mode in modes:
            X = combine(dbf, dba, mode)
            for white in whites:
                mean, P = fit_pca(X, white)
                db = project(X, mean, P)
                sq = project(combine(sqf, sqa, mode), mean, P)
                rqs = [project(combine(a, c, mode), mean, P) for a, c in rq]
                m, res = evaluate(db, names, sq, syn_idx, real, rqs)
                m.update({'backbone': b, 'mode': mode, 'white': white})
                table.append(m)
                log(f'  {b:6s} {mode:4s} white={int(white)}  sint: id {m["syn_top1_id"]:.3f} nome {m["syn_top1_name"]:.3f} '
                    f'top5 {m["syn_top5_id"]:.3f} | reais: {m["real_name_acc"]:.2f} pos {m["real_pos_scores"]} neg {m["real_neg_scores"]}')
                key = (m['real_name_acc'], m['syn_top1_name'])
                if best is None or key > best[0]:
                    best = (key, b, mode, white, mean, P, db, res, sq)
        cache_feats[b] = fm

    _, b, mode, white, mean, P, db, res, sq = best
    log(f'ESCOLHIDO: {b} {mode} white={white}')
    json.dump({'backbone': b, 'mode': mode, 'white': white}, open(os.path.join(OUT, 'chosen.json'), 'w'))

    # relatório visual: fotos reais (recorte usado x carta encontrada) e erros das simuladas
    rows = []
    for r, x in zip(real, res):
        t = x['top'][0]
        ok = x['label'] in LABELS and LABELS[x['label']](names[t])
        rows.append((r['cands'][x['cand']], load_card(ids[t]),
                     f"{r['file'][:20]} {x['kind']} {x['score']:.3f} m{x['margin']:.3f} -> {ids[t]} {names[t]}", ok))
    contact(rows, os.path.join(OUT, 'report_real.jpg'))
    S = sq @ db.T
    t1 = S.argmax(1)
    wrong = [k for k in range(len(t1)) if names[t1[k]] != names[syn_idx[k]]][:24]
    contact([(syn_imgs[k], load_card(ids[t1[k]]), f'{ids[syn_idx[k]]} -> {ids[t1[k]]} {S[k, t1[k]]:.3f} {names[t1[k]]}', False)
             for k in wrong], os.path.join(OUT, 'report_syn_errors.jpg'))

    # exportação
    fm = cache_feats[b]
    tfl = os.path.join(OUT, 'model.tflite')
    sel = [i for i in range(0, N, max(1, N // 24))][:24]
    chk = [load_card(ids[i]) for i in sel]
    for quant in (True, False):
        export_tflite(fm, mode, mean, P, tfl, quant)
        cos = (tflite_embed(tfl, chk) * db[sel]).sum(1)
        log(f'tflite (8 bits={quant}) x keras: cosseno mín {cos.min():.4f}')
        if cos.min() > 0.985:
            break
    log(f'tflite x keras: cosseno mín {cos.min():.4f} médio {cos.mean():.4f}; tamanho {os.path.getsize(tfl) / 1e6:.1f} MB')
    # o banco é recalculado com o próprio tflite? caro (N chamadas); usamos o do keras se bater bem
    db.astype('<f2').tofile(os.path.join(OUT, 'emb.f16'))
    with open(os.path.join(OUT, 'ids.txt'), 'w') as f:
        f.write('\n'.join(ids))
    best_m = next(t for t in table if t['backbone'] == b and t['mode'] == mode and t['white'] == white)
    version = time.strftime('%Y%m%d') + '-' + os.environ.get('GITHUB_RUN_NUMBER', 'local')
    manifest = {'version': version, 'count': N, 'dim': DIM, 'w': W, 'h': H, 'backbone': b, 'mode': mode,
                'white': white, 'tflite_cos_min': float(cos.min()), 'metrics': best_m,
                'files': {'model': 'model.tflite', 'emb': 'emb.f16', 'ids': 'ids.txt'}}
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    json.dump({'table': table, 'real': [{**x, 'top_ids': [ids[j] for j in x['top']]} for x in res]},
              open(os.path.join(OUT, 'report.json'), 'w'), indent=1)
    log('fim')


if __name__ == '__main__':
    main()
