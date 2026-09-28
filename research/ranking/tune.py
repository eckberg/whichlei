"""
Coordinate search on the TRAIN split only. Objective = mean MRR@10 over the six strata.

  python3 tune.py <name> [--pack words|postings] [--types 0123] [--mode merged]
                  [--wikidata]  [--passes 3]

P-weights change the per-file cap, so each P step rebuilds the kept sets and features
(~10 s). Match weights reuse the cached features (~1 s per step).
Writes cache/tune_<name>.json (best weights + trace).
"""
import argparse
import json
import math
import time

import evaluate as EV
import engine as EN
import ranking as R
from paths import CACHE

P_PARAMS = ['p_dead', 'p_lapsed', 'p_fund', 'p_branch_cat', 'p_sole', 'p_gov', 'p_children',
            'p_top', 'p_has_parent', 'p_branches', 'p_managed', 'p_isin', 'isin_cap', 'p_bic',
            'p_age', 'p_len']
M_PARAMS = ['m_all', 'm_miss', 'm_fuzzy', 'm_exact', 'm_core_exact', 'm_prefix',
            'm_coverage', 'm_order', 'm_alt']
STEP = {'isin_cap': 1.0, 'p_dead': 2.0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('--pack', default='postings')
    ap.add_argument('--types', default='0123')
    ap.add_argument('--mode', default='merged')
    ap.add_argument('--wikidata', action='store_true')
    ap.add_argument('--only', default='')
    ap.add_argument('--passes', type=int, default=3)
    ap.add_argument('--init', default='')
    ap.add_argument('--fold', type=int, default=-1, help='2-fold CV inside train: fit on the other fold, report this one')
    ap.add_argument('--min_gain', type=float, default=1e-4)
    a = ap.parse_args()
    rows = [r for r in EV.load_eval() if r['split'] == 'train']
    heldout = []
    if a.fold >= 0:
        import hashlib
        fold = lambda r: int(hashlib.sha1(f"cv:{r['target']}".encode()).hexdigest(), 16) % 2
        heldout = [r for r in rows if fold(r) == a.fold]
        rows = [r for r in rows if fold(r) != a.fold]
    W = dict(R.W_DEFAULT)
    if a.init:
        W.update(json.load(open(a.init))['W'])
    index_kw = {} if a.pack == 'words' else {'file_postings': EN.CAP}
    base = dict(types=tuple(int(c) for c in a.types), mode=a.mode, index_kw=index_kw)
    params = P_PARAMS + M_PARAMS
    if a.wikidata:
        params = ['p_wikidata'] + params
        W.setdefault('p_wikidata', 0.0)
    if a.only:
        params = a.only.split(',')
    runner = {'P_key': None, 'run': None}
    trace = []

    def obj(W):
        pkey = tuple(round(W.get(k, 0.0), 6) for k in P_PARAMS + ['p_wikidata'])
        if runner['P_key'] != pkey:
            runner['run'] = EV.Runner(dict(base, W=W))
            runner['P_key'] = pkey
        run = runner['run']
        run.cfg = dict(run.cfg, W=W)
        ms = EV.by_stratum(run.evaluate(rows))
        return EV.objective(ms), ms

    t0 = time.time()
    best, ms = obj(W)
    print(f'start obj={best:.4f}  {time.time() - t0:.0f}s', flush=True)
    trace.append(('start', best))
    step_scale = 1.0
    for p in range(a.passes):
        improved = False
        # match params first (cheap), then P params
        for k in [x for x in params if x in M_PARAMS] + [x for x in params if x not in M_PARAMS]:
            st = STEP.get(k, 1.0) * step_scale
            cur = W[k]
            for cand in (cur - st, cur + st, cur - 2 * st, cur + 2 * st):
                if k in ('m_miss', 'm_fuzzy', 'm_alt', 'isin_cap') and cand < 0:
                    continue
                W2 = dict(W, **{k: round(cand, 4)})
                v, ms2 = obj(W2)
                if v > best + a.min_gain:
                    best, W, ms = v, W2, ms2
                    improved = True
                    print(f'  pass {p} {k} {cur:+.2f} -> {cand:+.2f}  obj={best:.4f}  '
                          f'{time.time() - t0:.0f}s', flush=True)
                    trace.append((k, cand, best))
                    break
        if not improved:
            step_scale /= 2
            print(f'pass {p}: no improvement, step -> {step_scale}', flush=True)
        json.dump({'W': W, 'obj': best, 'ms': ms, 'trace': trace, 'args': vars(a)},
                  open(CACHE + f'tune_{a.name}.json', 'w'), indent=1)
    print('final obj', round(best, 4))
    if heldout:
        run = EV.Runner(dict(base, W=W))
        ho = EV.objective(EV.by_stratum(run.evaluate(heldout)))
        print('HELDOUT obj', round(ho, 4))
        d = json.load(open(CACHE + f'tune_{a.name}.json'))
        d['heldout_obj'] = ho
        json.dump(d, open(CACHE + f'tune_{a.name}.json', 'w'), indent=1)
    for s, m in ms.items():
        print(f"  {s:12s} S@1 {m['S@1']:.3f} S@10 {m['S@10']:.3f} MRR {m['MRR']:.3f} inshard {m['inshard']:.3f}")
    print(json.dumps(W))


if __name__ == '__main__':
    main()
