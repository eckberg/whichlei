"""
Fit all weights jointly with a conditional-logit (listwise softmax) model on TRAIN:

    P(target | query) = exp(s(q, target)) / sum_{c in candidates(q)} exp(s(q, c))
    s(q, e) = w_match . match_features(q, e) + w_P . prominence_features(e)

which is exactly ranking.py's score (P(e) = w_P . features). Convex; L2-regularised;
each stratum gets equal total weight. Candidates = entities the client would show
(after the per-file cap), truncated to the target + the 300 best under the current
weights. lambda chosen by 2-fold cross-validation inside train (folds by entity).

  python3 fit_logit.py <name> [--init cache/tune_post.json] [--wikidata] [--pack postings]
"""
import argparse
import hashlib
import json
import math
import os
import time

import numpy as np
from scipy.optimize import minimize

import engine as EN
import evaluate as EV
import ranking as R
from paths import CACHE

M_FEATS = ['m_all', 'm_miss', 'm_fuzzy', 'm_exact', 'm_core_exact', 'm_prefix', 'm_coverage',
           'm_order', 'm_alt']
P_FEATS = ['p_dead', 'p_lapsed', 'p_fund', 'p_branch_cat', 'p_sole', 'p_gov', 'p_children',
           'p_top', 'p_has_parent', 'p_branches', 'p_managed', 'p_isin', 'p_bic', 'p_age', 'p_len']
PF_KEY = {'p_dead': 'dead', 'p_lapsed': 'lapsed', 'p_fund': 'fund', 'p_branch_cat': 'branch_cat',
          'p_sole': 'sole', 'p_gov': 'gov', 'p_children': 'children', 'p_top': 'top',
          'p_has_parent': 'has_parent', 'p_branches': 'branches', 'p_managed': 'managed',
          'p_bic': 'bic', 'p_age': 'age', 'p_len': 'len', 'p_wikidata': 'wikidata'}
TOPK = 300
DROPPED = set()


def match_matrix(F):
    n = F['n']
    cols = {
        'm_all': (F['n_miss'] == 0).astype(float), 'm_miss': -F['n_miss'].astype(float),
        'm_fuzzy': -F['n_fuzzy'].astype(float), 'm_exact': F['n_exact'] / n,
        'm_core_exact': F['core_exact'].astype(float), 'm_prefix': F['seq_prefix'].astype(float),
        'm_coverage': F['coverage'].astype(float), 'm_order': F['in_order'].astype(float),
        'm_alt': -F['alt'].astype(float)}
    return np.stack([cols[k] for k in M_FEATS], 1)


def build(run, rows, W, feats_p, isin_cap):
    """Design matrix: one block per query (target first is NOT assumed)."""
    PF = EN.prominence_features()
    wm = np.array([W.get(k, 0.0) for k in M_FEATS])
    P = run.P
    X, grp, tgt, wts, strata = [], [], [], [], []
    nst = {}
    for r in rows:
        nst[r['stratum']] = nst.get(r['stratum'], 0) + 1
    g = 0
    for r in rows:
        Q, files, C, _ = run.query(r['query'])
        F = run._F[(r['query'], True, True)][3]
        if F is None or len(F['ent']) == 0:
            continue
        M = match_matrix(F)
        ms = M @ wm
        ent = F['ent']
        order = np.lexsort((-ms, ent))            # best row per entity
        first = np.concatenate([[True], ent[order][1:] != ent[order][:-1]])
        rows_best = order[first]
        ue = ent[rows_best]
        sc = ms[rows_best] + P[ue]
        is_t = np.isin(ue, list(r['targets']))
        if not is_t.any():
            continue
        keep = np.argsort(-sc, kind='stable')[:TOPK]
        keep = np.union1d(keep, np.where(is_t)[0])
        ue, mrow = ue[keep], M[rows_best[keep]]
        is_t = is_t[keep]
        pcols = []
        for k in feats_p:
            if k == 'p_isin':
                pcols.append(np.minimum(PF['isin_log'][ue], isin_cap))
            else:
                pcols.append(PF[PF_KEY[k]][ue])
        Xq = np.concatenate([mrow, np.stack(pcols, 1)], 1)
        t = int(np.argmax(np.where(is_t, sc[keep], -np.inf)))    # best-scoring target
        X.append(Xq)
        grp.append(np.full(len(ue), g))
        tgt.append(t)
        wts.append(1.0 / nst[r['stratum']])
        strata.append(r['stratum'])
        g += 1
    return (np.concatenate(X), np.concatenate(grp), np.array(tgt), np.array(wts) / np.sum(wts) * g)


def fit(X, grp, tgt, wts, lam):
    starts = np.concatenate([[0], np.where(np.diff(grp) != 0)[0] + 1])
    tpos = starts + tgt
    G = len(starts)
    rw = wts[grp]
    Xt = X[tpos]

    def f(w):
        s = X @ w
        mx = np.maximum.reduceat(s, starts)
        e = np.exp(s - mx[grp])
        Z = np.add.reduceat(e, starts)
        lse = mx + np.log(Z)
        loss = np.sum(wts * (lse - s[tpos])) / G + 0.5 * lam * w @ w
        p = e / Z[grp]
        grad = (X * (p * rw)[:, None]).sum(0) / G - (Xt * wts[:, None]).sum(0) / G + lam * w
        return loss, grad

    w0 = np.zeros(X.shape[1])
    res = minimize(f, w0, jac=True, method='L-BFGS-B', options={'maxiter': 500})
    return res.x, res.fun


def to_W(w, feats_p, isin_cap, base):
    W = dict(base)
    for k in DROPPED:
        W[k] = 0.0
    for k, v in zip(M_FEATS, w[:len(M_FEATS)]):
        W[k] = float(v)
    for k, v in zip(feats_p, w[len(M_FEATS):]):
        W[k] = float(v)
    W['isin_cap'] = isin_cap
    return W


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('--init', default=CACHE + 'tune_post.json')
    ap.add_argument('--wikidata', action='store_true')
    ap.add_argument('--pack', default='postings')
    ap.add_argument('--types', default='0123')
    ap.add_argument('--isin_cap', type=float, default=math.log1p(50))
    ap.add_argument('--drop', default='', help='comma-separated weights fixed at 0')
    ap.add_argument('--lams', default='0.0001,0.0003,0.001,0.003,0.01')
    ap.add_argument('--nocore', action='store_true', help='core name = full name (no legal-form stripping)')
    ap.add_argument('--mode', default='merged', help="routing: merged | first | longest | budget")
    ap.add_argument('--route', default='', help='budget routing params as JSON (default ranking.ROUTE)')
    ap.add_argument('--nofuzzy', action='store_true', help='disable fuzzy matching')
    ap.add_argument('--write', default='', help='also write rounded weights to this json')
    a = ap.parse_args()
    if a.nofuzzy:
        R.FUZZY_MIN_LEN = 99
    drop = set(x for x in a.drop.split(',') if x)
    global M_FEATS, P_FEATS
    M_FEATS = [k for k in M_FEATS if k not in drop]
    P_FEATS = [k for k in P_FEATS if k not in drop]
    DROPPED.update(drop)
    t0 = time.time()
    rows = [r for r in EV.load_eval() if r['split'] == 'train']
    W0 = json.load(open(a.init))['W'] if a.init else dict(R.W_DEFAULT)
    W0 = dict(W0)
    feats_p = P_FEATS + (['p_wikidata'] if a.wikidata else [])
    if not a.wikidata:
        W0['p_wikidata'] = 0.0
    index_kw = {'file_postings': EN.CAP} if a.pack == 'postings' else {}
    base = dict(types=tuple(int(c) for c in a.types), mode=a.mode, index_kw=index_kw,
                strip=not a.nocore)
    if a.mode == 'budget':
        base['route'] = dict(R.ROUTE, **(json.loads(a.route) if a.route else {}))
    fold = {r['target']: int(hashlib.sha1(f"cv:{r['target']}".encode()).hexdigest(), 16) % 2 for r in rows}

    HEADISH = ('head_label', 'head_alias', 'typo_first3', 'typo_later')

    def evaluate(W, rs, both=False):
        run = EV.Runner(dict(base, W=W))
        res = run.evaluate(rs)
        o = EV.objective(EV.by_stratum(res))
        if not both:
            return o
        ng = [x for x in res if not (x['stratum'] in HEADISH and x['kind'] == 'gov')]
        return o, EV.objective(EV.by_stratum(ng))

    run0 = EV.Runner(dict(base, W=W0))
    # --- lambda by 2-fold CV inside train --------------------------------------------
    cv, cv_nogov = {}, {}
    for lam in [float(x) for x in a.lams.split(',')]:
        vals = []
        for k in (0, 1):
            tr = [r for r in rows if fold[r['target']] != k]
            va = [r for r in rows if fold[r['target']] == k]
            X, grp, tgt, wts = build(run0, tr, W0, feats_p, a.isin_cap)
            w, _ = fit(X, grp, tgt, wts, lam)
            vals.append(evaluate(to_W(w, feats_p, a.isin_cap, W0), va, both=True))
        cv[lam] = float(np.mean([v[0] for v in vals]))
        cv_nogov[lam] = float(np.mean([v[1] for v in vals]))
        print(f'  cv lambda={lam}: {cv[lam]:.4f}  (governments excluded from head strata: '
              f'{cv_nogov[lam]:.4f})  [{time.time() - t0:.0f}s]', flush=True)
    cv_init = float(np.mean([evaluate(W0, [r for r in rows if fold[r['target']] == k]) for k in (0, 1)]))
    print(f'  cv of init weights: {cv_init:.4f}')
    lam = max(cv, key=cv.get)
    # --- final fit on all train, 2 rounds (re-pick best rows under the new weights) -----
    W = W0
    for it in range(2):
        run = EV.Runner(dict(base, W=W))
        X, grp, tgt, wts = build(run, rows, W, feats_p, a.isin_cap)
        w, loss = fit(X, grp, tgt, wts, lam)
        W = to_W(w, feats_p, a.isin_cap, W0)
        obj = evaluate(W, rows)
        print(f'  round {it}: {len(tgt)} queries, {X.shape[0]:,} candidate rows, loss {loss:.4f}, '
              f'train obj {obj:.4f}  [{time.time() - t0:.0f}s]', flush=True)
    json.dump({'W': W, 'lambda': lam, 'cv': cv, 'cv_nogov': cv_nogov, 'cv_init': cv_init,
               'train_obj': obj, 'args': vars(a)},
              open(os.path.join(CACHE, f'logit_{a.name}.json'), 'w'), indent=1)
    if a.write:
        Wr = {k: (round(v, 3) if k == 'isin_cap' else round(v, 2)) for k, v in W.items()}
        json.dump({'W': Wr, 'strip': not a.nocore, 'lambda': lam, 'cv': cv, 'cv_nogov': cv_nogov,
                   'config': {k: v for k, v in base.items() if k != 'index_kw'},
                   'source': f'fit_logit.py {a.name}, rounded to 2 decimals'},
                  open(a.write, 'w'), indent=1)
    print(json.dumps({k: round(v, 3) for k, v in W.items()}))


if __name__ == '__main__':
    main()
