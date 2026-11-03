"""Treina a rede de reconhecimento nas próprias cartas (roda no GitHub Actions, CPU, de graça).

Cada carta é uma "classe"; a cada passo a rede vê fotos simuladas (tortas, desfocadas, com reflexo,
holográfico, longe) e aprende a dar o mesmo vetor para a mesma carta e vetores diferentes para cartas
diferentes (CosFace). Depois exporta o mesmo formato do build_db.py: model.tflite + emb.f16 + ids.txt.

Uso: python vision/train.py --minutes 150
"""
import argparse
import json
import math
import multiprocessing as mp
import os
import sys
import time

os.environ.setdefault('TF_USE_LEGACY_KERAS', '1')
import cv2  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
import build_db as B  # noqa: E402
from cardvision import H, W  # noqa: E402

DIM = 256


def _job(a):
    cid, seed = a
    return B.augment(B.load_native(cid), np.random.default_rng(seed))


def regional_head(fmap, tf):
    L = tf.keras.layers
    h, w = int(fmap.shape[1]), int(fmap.shape[2])
    outs = []
    for (a, b, c, d) in B._regions(h, w, 'full'):
        v = L.Lambda(lambda t, a=a, b=b, c=c, d=d: tf.reduce_mean(t[:, a:b, c:d, :], axis=[1, 2]))(fmap)
        outs.append(v)
    return L.Concatenate()(outs)


def build(nclass, backbone):
    import tensorflow as tf
    keras = tf.keras
    kw = dict(include_top=False, weights='imagenet', input_shape=(H, W, 3), include_preprocessing=True)
    bb = (keras.applications.MobileNetV3Large if backbone == 'mnv3l' else keras.applications.MobileNetV3Small)(**kw)
    for l in bb.layers:  # BatchNorm congelado: estável com lotes pequenos
        if isinstance(l, keras.layers.BatchNormalization):
            l.trainable = False
    inp = keras.Input((H, W, 3), name='card')
    f = regional_head(bb(inp, training=False), tf)
    f = keras.layers.Dropout(0.1)(f)
    e = keras.layers.Dense(DIM, use_bias=False, name='proj')(f)
    e = keras.layers.UnitNormalization(name='emb')(e)
    emb_model = keras.Model(inp, e, name='emb')
    return emb_model


class CosFace:
    def __init__(self, nclass, s=30.0, m=0.25):
        import tensorflow as tf
        self.tf = tf
        init = tf.keras.initializers.GlorotUniform()
        self.Wc = tf.Variable(init((DIM, nclass)), name='classes')
        self.s, self.m = s, m

    def loss(self, emb, y):
        tf = self.tf
        Wn = tf.math.l2_normalize(self.Wc, axis=0)
        cos = tf.matmul(emb, Wn)
        onehot = tf.one_hot(y, tf.shape(cos)[1])
        logits = self.s * (cos - self.m * onehot)
        return tf.reduce_mean(tf.nn.sparse_softmax_cross_entropy_with_logits(labels=y, logits=logits))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--minutes', type=float, default=150)
    ap.add_argument('--batch', type=int, default=64)
    ap.add_argument('--backbone', default='mnv3s')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()
    os.makedirs(B.OUT, exist_ok=True)

    cards = B.download_all(B.fetch_cards())
    if args.limit:
        cards = cards[:args.limit]
    ids = [c['id'] for c in cards]
    names = [B.norm_name(c['name']) for c in cards]
    N = len(ids)

    pool = mp.Pool(max(1, (os.cpu_count() or 2)))  # antes de carregar o TensorFlow
    import tensorflow as tf
    rng = np.random.default_rng(7)
    syn_idx = rng.choice(N, size=min(1500, N), replace=False)
    syn_imgs = pool.map(_job, [(ids[i], 1000 + k) for k, i in enumerate(syn_idx)], chunksize=32)
    real = B.real_queries()
    neg_imgs = B.negatives([r['img'] for r in real if r['label'] == 'none'], rng)
    for k in range(len(neg_imgs)):
        if neg_imgs[k] is None:
            c = B.load_native(ids[int(rng.integers(N))])
            h, w = c.shape[:2]
            y0 = int(rng.uniform(0.05, 0.4) * h)
            x0 = int(rng.uniform(0.0, 0.3) * w)
            neg_imgs[k] = cv2.resize(c[y0:y0 + int(0.45 * h), x0:x0 + int(0.6 * w)], (W, H))

    model = build(N, args.backbone)
    head = CosFace(N)
    opt = tf.keras.optimizers.Adam(1e-3)
    params = model.trainable_variables + [head.Wc]

    @tf.function
    def step(x, y):
        with tf.GradientTape() as tape:
            e = model(x, training=True)
            loss = head.loss(e, y)
        g = tape.gradient(loss, params)
        opt.apply_gradients(zip(g, params))
        return loss

    def batches(epoch):
        order = np.random.default_rng(epoch).permutation(N)
        jobs = [(ids[i], epoch * 10_000_019 + int(i)) for i in order]
        it = pool.imap(_job, jobs, chunksize=8)
        buf, lab = [], []
        for k, img in enumerate(it):
            buf.append(img)
            lab.append(order[k])
            if len(buf) == args.batch:
                yield np.asarray(buf, np.float32), np.asarray(lab, np.int32)
                buf, lab = [], []

    def embed(imgs, bs=128):
        out = []
        for i in range(0, len(imgs), bs):
            out.append(model(np.asarray(imgs[i:i + bs], np.float32), training=False).numpy())
        return np.concatenate(out)

    def db_embed():
        out = []
        for i in range(0, N, 512):
            out.append(embed([B.load_card(c) for c in ids[i:i + 512]]))
        return np.concatenate(out)

    def evaluate(tag):
        db = db_embed()
        m, res = B.evaluate(db, names, embed(syn_imgs), syn_idx, real, [embed(r['cands']) for r in real], embed(neg_imgs))
        B.log(f'[{tag}] sint: id {m["syn_top1_id"]:.3f} nome {m["syn_top1_name"]:.3f} top5 {m["syn_top5_id"]:.3f} | '
              f'lim {m["thr_min"]:.2f}/{m["thr_strong"]:.2f} recall {m["syn_recall_min"]:.2f}/{m["syn_recall_strong"]:.2f} '
              f'prec {m["syn_precision_min"]:.3f} | reais {m["real_name_acc"]:.2f} pos {m["real_pos_scores"]} '
              f'neg {m["real_neg_scores"]}')
        return db, m, res

    evaluate('antes do treino')
    t0 = time.time()
    budget = args.minutes * 60
    gstep = 0
    epoch = 0
    first_epoch_time = None
    while True:
        te = time.time()
        losses = []
        for x, y in batches(epoch):
            # LR: cosseno ao longo do tempo disponível
            frac = min(1.0, (time.time() - t0) / budget)
            opt.learning_rate.assign(1e-3 * (0.02 + 0.98 * 0.5 * (1 + math.cos(math.pi * frac))))
            losses.append(float(step(x, y)))
            gstep += 1
            if gstep % 50 == 0:
                B.log(f'época {epoch} passo {gstep} perda {np.mean(losses[-50:]):.3f} lr {float(opt.learning_rate.numpy()):.5f}')
            if time.time() - t0 > budget:
                break
        epoch += 1
        if first_epoch_time is None:
            first_epoch_time = time.time() - te
            B.log(f'1 época = {first_epoch_time / 60:.1f} min')
        if time.time() - t0 > budget:
            break
        if epoch % 4 == 0:
            evaluate(f'época {epoch}')
    pool.close()

    db, m, res = evaluate('final')
    # relatório
    rows = []
    for r, x in zip(real, res):
        t = x['top'][0]
        ok = x['label'] in B.LABELS and B.LABELS[x['label']](names[t])
        rows.append((r['cands'][x['cand']], B.load_card(ids[t]),
                     f"{r['file'][:20]} {x['kind']} {x['score']:.3f} m{x['margin']:.3f} -> {ids[t]} {names[t]}", ok))
    B.contact(rows, os.path.join(B.OUT, 'report_real.jpg'))
    json.dump({'metrics': m, 'real': [{**x, 'top_ids': [ids[j] for j in x['top']], 'top_names': [names[j] for j in x['top']]}
                                      for x in res]}, open(os.path.join(B.OUT, 'report.json'), 'w'), indent=1)

    # exportação
    tfl = os.path.join(B.OUT, 'model.tflite')
    sel = list(range(0, N, max(1, N // 24)))[:24]
    chk = [B.load_card(ids[i]) for i in sel]
    cos = np.zeros(1)
    for quant in (True, False):
        conv = tf.lite.TFLiteConverter.from_keras_model(model)
        if quant:
            conv.optimizations = [tf.lite.Optimize.DEFAULT]
            conv.target_spec.supported_types = [tf.float16]
        open(tfl, 'wb').write(conv.convert())
        cos = (B.tflite_embed(tfl, chk) * db[sel]).sum(1)
        B.log(f'tflite (8 bits={quant}) x keras: cosseno mín {cos.min():.4f}; {os.path.getsize(tfl) / 1e6:.1f} MB')
        if cos.min() > 0.985:
            break
    db.astype('<f2').tofile(os.path.join(B.OUT, 'emb.f16'))
    open(os.path.join(B.OUT, 'ids.txt'), 'w').write('\n'.join(ids))
    B.write_meta(cards, os.path.join(B.OUT, 'cards.tsv'))
    model.save_weights(os.path.join(B.OUT, 'weights.h5'))
    version = time.strftime('%Y%m%d') + '-t' + os.environ.get('GITHUB_RUN_NUMBER', 'local')
    json.dump({'version': version, 'count': N, 'dim': DIM, 'w': W, 'h': H, 'backbone': args.backbone, 'method': 'trained',
               'epochs': epoch, 'tflite_cos_min': float(cos.min()),
               'thresholds': {'min': round(m['thr_min'], 3), 'strong': round(m['thr_strong'], 3)},
               'metrics': m, 'files': {'model': 'model.tflite', 'emb': 'emb.f16', 'ids': 'ids.txt', 'meta': 'cards.tsv'}},
              open(os.path.join(B.OUT, 'manifest.json'), 'w'), indent=1)
    B.log('fim')


if __name__ == '__main__':
    main()
