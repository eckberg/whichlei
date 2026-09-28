"""Grid over cost-bounded routing parameters on the TRAIN split only.
Quality: objective (mean MRR@10 over 6 strata), with and without government targets in
the head-derived strata. Cost: typing each query one character at a time with a cache.
Weights: W given in argv[1] (json with 'W'); p_gov forced to 0. Output: cache/route_grid.jsonl"""
import itertools
import json
import sys
import time

import evaluate as EV
import ranking as R
from paths import CACHE

HEADISH = ('head_label', 'head_alias', 'typo_first3', 'typo_later')
W = json.load(open(sys.argv[1]))['W']
W['p_gov'] = 0.0
out = open(sys.argv[2] if len(sys.argv) > 2 else CACHE + 'route_grid.jsonl', 'w')
POST = {'file_postings': 1500}
rows = [r for r in EV.load_eval() if r['split'] == 'train']
nogov = [r for r in rows if not (r['stratum'] in HEADISH and r['kind'] == 'gov')]
base = EV.Runner(dict(W=W, types=(0, 1, 2, 3), mode='merged', index_kw=POST, strip=False))
kb = EV.file_kb(base)
t0 = time.time()


def run_cfg(name, cfg):
    run = EV.Runner(cfg)
    res = run.evaluate(rows)
    ms = EV.by_stratum(res)
    ids = set(id(r) for r in nogov)
    ms_ng = EV.by_stratum([x for x, r in zip(res, rows) if id(r) in ids])
    cost = EV.cost_summary([EV.session_cost(run, r['query'], kb) for r in rows])
    cost_e = EV.cost_summary([EV.session_cost(run, r['query'], kb, eager=True) for r in rows])
    rec = dict(name=name, route=cfg.get('route'), mode=cfg['mode'], obj=EV.objective(ms),
               obj_nogov=EV.objective(ms_ng), mrr={s: ms[s]['MRR'] for s in ms},
               inshard={s: ms[s]['inshard'] for s in ms}, cost=cost, cost_eager=cost_e)
    out.write(json.dumps(rec) + '\n')
    out.flush()
    c = cost
    print(f"{name:34s} obj {rec['obj']:.4f} nogov {rec['obj_nogov']:.4f} | typed KB p90 {c['kb']['p90']:.0f} "
          f"max {c['kb']['max']:.0f} | cand p90 {c['cand_max']['p90']:.0f} max {c['cand_max']['max']:.0f} | "
          f"eager KB p90 {cost_e['kb']['p90']:.0f} max {cost_e['kb']['max']:.0f}  [{time.time() - t0:.0f}s]", flush=True)


common = dict(W=W, types=(0, 1, 2, 3), index_kw=POST, strip=False)
run_cfg('merged (current)', dict(common, mode='merged'))
GRID = list(itertools.product((3, 4), (1, 2, 3), (1, 2, 3)))
if len(sys.argv) > 3 and sys.argv[3] == 'short':
    GRID = [(3, 1, 2), (3, 2, 2), (3, 3, 2), (3, 1, 3), (4, 1, 2)]
for mc, K, A in GRID:
    p = dict(R.ROUTE, min_chars=mc, max_span=K, max_anchors=A)
    run_cfg(f'budget mc{mc} K{K} A{A}', dict(common, mode='budget', route=p))
if len(sys.argv) <= 3:
    p = dict(R.ROUTE, short_single=False)
    run_cfg('budget default, no short_single', dict(common, mode='budget', route=p))
print('DONE')
