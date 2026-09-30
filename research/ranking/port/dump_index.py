"""
The reference index, dumped for the index-format measurements (slice 4). Data plumbing
only: it runs the 'final' configuration of report.py (ranking.W_RECOMMENDED, ranking.ROUTE,
per-shard cap, name types 0-3, no legal-form stripping) and writes what it built.

Run after prep.py (see dump_parity.py for the prerequisites):
    python3 port/dump_index.py

Outputs under $DATA_DIR/index/ (not committed):
  files.tsv     one line per index file, in routing order:
                first term, capped (0/1), entity ids in file order (P desc, id asc)
  entities.tsv  one line per entity in any file:
                id, lei, country, status, P (full precision), registration age in years,
                legal name, alternative names...
                status: registration status letter (I issued, L lapsed, T pending
                transfer, P pending archival, R retired, D duplicate, A annulled,
                M merged), lower case when the entity status is INACTIVE
Output committed to packages/core/fixtures/route.json:
  bounds, capped  the routing table
  cases           [query, routes]: every distinct evaluation query typed one character
                  at a time. routes has one string per keystroke: the files that
                  ranking.route_budget returns while typing (paused=False) and on a
                  pause (paused=True), as "a,b|c,d"
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

import engine as EN  # noqa: E402
import evaluate as EV  # noqa: E402
import ranking as R  # noqa: E402
import sizes as SZ  # noqa: E402
from paths import DATA_DIR  # noqa: E402
from report import cfg_final  # noqa: E402

OUT = os.path.join(DATA_DIR, 'index')
FIXTURE = os.path.join(HERE, '..', '..', '..', 'packages', 'core', 'fixtures', 'route.json')
STATUS = {'ISSUED': 'I', 'LAPSED': 'L', 'PENDING_TRANSFER': 'T', 'PENDING_ARCHIVAL': 'P',
          'RETIRED': 'R', 'DUPLICATE': 'D', 'ANNULLED': 'A', 'MERGED': 'M'}
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.0f}s]', *a, flush=True)


def dump_index(run):
    E = EN.ents()
    idx, P = run.idx, run.P
    kptr, kents = run.kept
    alt = SZ.load_alt_strings(idx)
    reachable = np.zeros(len(E['lei']), dtype=bool)
    with open(os.path.join(OUT, 'files.tsv'), 'w', encoding='utf-8') as f:
        for i, bound in enumerate(idx.bounds):
            es = kents[kptr[i]:kptr[i + 1]]
            es = es[np.lexsort((es, -P[es]))]
            reachable[es] = True
            f.write(f'{bound}\t{int(idx.capped[i])}\t{" ".join(map(str, es.tolist()))}\n')
    log(f'files.tsv: {idx.n_files} files, {int(kptr[-1]):,} entries')
    rs_names = E['RS']
    age = np.nan_to_num(EN.NOW_YEAR - E['regy'], nan=0.0)
    n = 0
    with open(os.path.join(OUT, 'entities.tsv'), 'w', encoding='utf-8') as f:
        for e in np.flatnonzero(reachable).tolist():
            st = STATUS[rs_names[E['rs'][e]]]
            if E['es'][e] == 0:
                st = st.lower()
            names = [E['name'][e]] + alt.get(e, [])
            for nm in names:
                assert '\t' not in nm and '\n' not in nm, nm
            f.write('\t'.join([str(e), E['lei'][e], E['country'][e], st, repr(float(P[e])),
                               repr(float(age[e]))] + names) + '\n')
            n += 1
    log(f'entities.tsv: {n:,} entities')


def dump_route_fixture(run):
    idx = run.idx
    qs = list(dict.fromkeys(r['query'] for r in EV.load_eval()))
    cases = []
    for q in qs:
        routes = []
        for k in range(1, len(q) + 1):
            pre = q[:k]
            Q = R.query_tokens(pre)
            last_is_prefix = not pre.endswith(' ')
            typing = R.route_budget(Q, idx.bounds, idx.capped, last_is_prefix, False)
            paused = R.route_budget(Q, idx.bounds, idx.capped, last_is_prefix, True)
            routes.append(','.join(map(str, typing)) + '|' + ','.join(map(str, paused)))
        cases.append([q, routes])
    capped = [i for i, c in enumerate(idx.capped) if c]
    with open(FIXTURE, 'w', encoding='utf-8') as f:
        json.dump(dict(bounds=idx.bounds, capped=capped, cases=cases), f, ensure_ascii=False,
                  separators=(',', ':'))
    log(f'route.json: {len(cases)} queries, {sum(len(c[1]) for c in cases):,} keystrokes')


def main():
    os.makedirs(OUT, exist_ok=True)
    run = EV.Runner(cfg_final(dict(R.W_RECOMMENDED)))
    log(f'index: {run.idx.n_files} files')
    dump_route_fixture(run)
    dump_index(run)


if __name__ == '__main__':
    main()
