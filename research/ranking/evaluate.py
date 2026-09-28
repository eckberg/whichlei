"""
Evaluation harness. Usage:
  python3 evaluate.py --selftest      # engine == ranking.py (run from this directory)
  (other entry points are used from tune.py / report.py)

A config is a dict:
  W        weights (ranking.W_DEFAULT keys)
  types    indexed name-variant types, e.g. (0,) or (0,1,2,3)
  mode     routing: 'first' | 'longest' | 'merged'
  f_max    max files fetched for the (prefix) last token
  b0       True -> baseline B0 (v2 tokens, P_B0, first-token routing, AND + order by P)
  P        optional explicit prominence array (overrides W's prominence)
  cap      per-file cap
"""
import collections
import math
import sys
import time

import numpy as np

import engine as EN
import prep_v2
import ranking as R
from paths import EVAL

STRATA = ['head_label', 'head_alias', 'torso', 'tail', 'typo_first3', 'typo_later']

_INDEX = {}


def get_index(tokset, types, strip=True, **kw):
    key = (tokset, tuple(sorted(types)), strip, tuple(sorted(kw.items())))
    if key not in _INDEX:
        _INDEX[key] = EN.Index(tokset, types, strip=strip, **kw)
    return _INDEX[key]


def load_eval():
    E = EN.ents()
    l2i = E['lei2id']
    pairs = np.load(EN.CACHE + 'pairs.npz')
    direct = pairs['type'] == 0
    nbr = collections.defaultdict(set)
    for c, p in zip(pairs['child'][direct], pairs['parent'][direct]):
        nbr[int(c)].add(int(p))
        nbr[int(p)].add(int(c))
    rows = []
    for name in ('head', 'torso', 'tail', 'typo'):
        with open(EVAL + name + '.tsv', encoding='utf-8') as f:
            hdr = f.readline().rstrip('\n').split('\t')
            for line in f:
                d = dict(zip(hdr, line.rstrip('\n').split('\t')))
                qt = d['qtype']
                if name == 'head':
                    st = 'head_' + qt
                elif name == 'typo':
                    st = qt.split(':')[0]
                else:
                    st = name
                tgt = {l2i[d['target_lei']]} | {l2i[x] for x in d['alt_leis'].split('|') if x}
                len_ = set()
                for t in tgt:
                    len_ |= nbr.get(t, set())
                cat = E['CAT'][E['cat'][l2i[d['target_lei']]]]
                kind = 'gov' if cat in ('RESIDENT_GOVERNMENT_ENTITY', 'INTERNATIONAL_ORGANIZATION') else 'company'
                rows.append(dict(query=d['query'], target=l2i[d['target_lei']], targets=tgt,
                                 lenient=tgt | len_, stratum=st, split=d['split'], qtype=qt,
                                 kind=kind, name=d['entity_name']))
    return rows


def v2_query_tokens(q):
    import re
    return re.findall(r'[a-z0-9]+', prep_v2.fold(q))


class Runner:
    """Holds index + kept sets for one config; evaluates queries."""

    def __init__(self, cfg):
        self.cfg = cfg
        b0 = cfg.get('b0', False)
        self.idx = get_index('v2' if b0 else 'v3', (0,) if b0 else cfg.get('types', (0,)),
                             strip=cfg.get('strip', True), **cfg.get('index_kw', {}))
        if cfg.get('P') is not None:
            self.P = cfg['P']
        elif b0:
            self.P = EN.prominence_b0()
        else:
            self.P = EN.prominence(cfg['W'])
        self.kept = self.idx.cap(self.P, cfg.get('cap', EN.CAP))
        self._F = {}

    def query(self, q, last_is_prefix=True, cache=True, paused=True):
        cfg = self.cfg
        b0 = cfg.get('b0', False)
        key = (q, last_is_prefix, paused)
        if cache and key in self._F:
            Q, files, C, F = self._F[key]
        else:
            Q = v2_query_tokens(q) if b0 else R.query_tokens(q)
            if b0:
                Q = [t for t in Q if len(t) >= 2]
            if not Q:
                files, C, F = [], np.zeros(0, dtype=np.int64), None
            else:
                files = self.idx.route(Q, 'first' if b0 else cfg.get('mode', 'merged'),
                                       last_is_prefix, cfg.get('f_max', R.F_MAX),
                                       cfg.get('route'), paused)
                C = EN.candidates(self.idx, self.kept, files)
                F = self.idx.features(Q, C)
            if cache:
                self._F[key] = (Q, files, C, F)
        if F is None:
            return Q, files, C, np.zeros(0, dtype=np.int64)
        return Q, files, C, EN.rank_entities(F, self.P, cfg.get('W'), b0=b0)

    def evaluate(self, rows):
        out = []
        for r in rows:
            Q, files, C, top = self.query(r['query'])
            top = list(top)
            rank = next((i + 1 for i, e in enumerate(top) if e in r['targets']), None)
            lrank = next((i + 1 for i, e in enumerate(top) if e in r['lenient']), None)
            in_shard = bool(np.isin(list(r['targets']), C).any()) if len(C) else False
            out.append(dict(r, rank=rank, lrank=lrank, in_shard=in_shard, top=top[:10],
                            nfiles=len(files)))
        return out

    def rerank(self, W):
        """Re-score cached features with new match weights (P unchanged)."""
        self.cfg = dict(self.cfg, W=W)


def metrics(res):
    n = len(res)
    if n == 0:
        return {}
    r = [x['rank'] for x in res]
    return {
        'n': n,
        'S@1': sum(1 for x in r if x == 1) / n,
        'S@5': sum(1 for x in r if x and x <= 5) / n,
        'S@10': sum(1 for x in r if x and x <= 10) / n,
        'MRR': sum(1.0 / x for x in r if x) / n,
        'inshard': sum(1 for x in res if x['in_shard']) / n,
        'lenS@1': sum(1 for x in res if x['lrank'] == 1) / n,
        'lenS@10': sum(1 for x in res if x['lrank'] and x['lrank'] <= 10) / n,
    }


def by_stratum(res):
    g = collections.defaultdict(list)
    for x in res:
        g[x['stratum']].append(x)
    return {s: metrics(g[s]) for s in STRATA if s in g}


def objective(ms):
    """Mean MRR@10 over the six strata (equal weight)."""
    return sum(ms[s]['MRR'] for s in STRATA if s in ms) / len([s for s in STRATA if s in ms])


def selftest(n=300):
    """Cross-check the vectorised engine against the plain reference scorer."""
    rows = [r for r in load_eval() if r['split'] == 'train']
    rng = np.random.default_rng(1)
    pick = [rows[i] for i in rng.choice(len(rows), n, replace=False)]
    W = dict(R.W_RECOMMENDED)
    cfg = dict(W=W, types=(0, 1, 2, 3), mode='budget', route=dict(R.ROUTE),
               index_kw={'file_postings': EN.CAP}, strip=R.STRIP_LEGAL_FORMS)
    run = Runner(cfg)
    idx = run.idx
    V = idx.vocab
    bad = 0
    for r in pick:
        Q, files, C, top = run.query(r['query'])
        entries = []
        for e in C:
            a, b = idx.eptr[e], idx.eptr[e + 1]
            vs = []
            for row in range(a, b):
                if not idx.row_on[row]:
                    continue
                seq = [V[t] for t in idx.tok[idx.tptr[row]:idx.tptr[row + 1]]]
                ext = [V[t] for t in idx.ext[idx.xptr[row]:idx.xptr[row + 1]]]
                vs.append((seq, ext, int(idx.cs[row]), int(idx.ce[row])))
            entries.append({'id': int(e), 'P': float(run.P[e]), 'variants': vs})
        ref = [e['id'] for e in R.top_k(Q, entries, W, 10)]
        if ref != list(top):
            bad += 1
            print('MISMATCH', r['query'], Q, ref[:5], list(top)[:5])
    print(f'selftest: {n - bad}/{n} queries identical top-10')


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()


def keystrokes(run, rows, max_len=60):
    """Replay each head label one character at a time. Returns per-query dicts with the
    first keystroke count at which the target is top-5 / top-1 (None = never)."""
    out = []
    for r in rows:
        s = r['query'][:max_len]
        k5 = k1 = None
        for k in range(1, len(s) + 1):
            pre = s[:k]
            if pre[-1] == ' ':
                continue                      # a space alone changes nothing visible
            Q, files, C, top = run.query(pre, last_is_prefix=True)
            top = list(top)
            rank = next((i + 1 for i, e in enumerate(top) if e in r['targets']), None)
            if rank and rank <= 5 and k5 is None:
                k5 = k
            if rank == 1:
                k1 = k
                break
        out.append(dict(query=r['query'], k5=k5, k1=k1, length=len(s)))
    return out


def keystroke_summary(ks):
    def med(vals):
        v = sorted(x if x is not None else 10 ** 6 for x in vals)
        m = v[len(v) // 2] if len(v) % 2 else (v[len(v) // 2 - 1] + v[len(v) // 2]) / 2
        return m if m < 10 ** 6 else float('inf')
    n = len(ks)
    return {
        'n': n,
        'median_k_top5': med([x['k5'] for x in ks]),
        'median_k_top1': med([x['k1'] for x in ks]),
        'reach_top5': sum(1 for x in ks if x['k5'] is not None) / n,
        'reach_top1': sum(1 for x in ks if x['k1'] is not None) / n,
        # among queries that do reach top-1: median share of the label typed
        'median_frac_top1': (sorted(x['k1'] / x['length'] for x in ks if x['k1'])[
            len([1 for x in ks if x['k1']]) // 2] if any(x['k1'] for x in ks) else None),
    }


def b1_results():
    """GLEIF API baseline on the 100-query sample -> {endpoint: [result rows]}. Empty if
    b1_gleif.py was skipped (SKIP_B1=1 in run_all.sh): there is no eval/b1_raw.jsonl to
    read (it is a raw API dump, not committed -- see the README)."""
    import json
    import os
    if not os.path.exists(EVAL + 'b1_raw.jsonl'):
        return {}
    E = EN.ents()
    l2i = E['lei2id']
    out = collections.defaultdict(list)
    for line in open(EVAL + 'b1_raw.jsonl', encoding='utf-8'):
        d = json.loads(line)
        tg = {d['target']} | {x for x in d['alts'].split('|') if x}
        rank = next((i + 1 for i, l in enumerate(d['leis'][:10]) if l in tg), None)
        out[d['endpoint']].append(dict(query=d['query'], rank=rank, lrank=None,
                                       in_shard=False, stratum='head_label'))
    return out


def paired_bootstrap(res_a, res_b, n_boot=1000, seed=7):
    """95% CI of (b - a) in MRR per stratum and in the objective. res_a/res_b are result
    lists over the same queries in the same order. Resamples target entities (clusters)
    within each stratum."""
    rng = np.random.default_rng(seed)
    rr = lambda x: 1.0 / x['rank'] if x['rank'] else 0.0
    out = {}
    per_stratum_boot = {}
    for s in STRATA:
        idx = [i for i, x in enumerate(res_a) if x['stratum'] == s]
        if not idx:
            continue
        groups = collections.defaultdict(list)
        for i in idx:
            groups[res_a[i]['target']].append(i)
        keys = list(groups)
        d = np.array([rr(res_b[i]) - rr(res_a[i]) for i in range(len(res_a))])
        gsum = np.array([d[groups[k]].sum() for k in keys])
        gcnt = np.array([len(groups[k]) for k in keys])
        boots = np.empty(n_boot)
        for b in range(n_boot):
            pick = rng.integers(0, len(keys), len(keys))
            boots[b] = gsum[pick].sum() / gcnt[pick].sum()
        per_stratum_boot[s] = boots
        out[s] = (gsum.sum() / gcnt.sum(), np.percentile(boots, 2.5), np.percentile(boots, 97.5))
    ob = np.mean([per_stratum_boot[s] for s in per_stratum_boot], axis=0)
    point = np.mean([out[s][0] for s in out])
    out['objective'] = (point, np.percentile(ob, 2.5), np.percentile(ob, 97.5))
    return out


def file_kb(run):
    """Per-file gzip size (KB) in the recommended entry format [lei, name, country, P, alts];
    cached per index (entry order barely changes with P)."""
    import os
    import sizes as SZ
    path = EN.CACHE + f'filekb_{len(run.idx.bounds)}_{"".join(map(str, run.idx.types))}.npy'
    if os.path.exists(path):
        return np.load(path)
    s = SZ.measure(run.idx, run.kept, run.P, ('base', '+P', '+alt'))
    kb = np.array(s['sizes']) / 1024.0
    np.save(path, kb)
    return kb


def session_cost(run, q, kb, eager=False):
    """Type q one character at a time with a file cache. Returns cumulative distinct files
    and KB fetched, max candidates (entries in the routed files) at any keystroke and at
    the final state. The in-progress word counts as 'paused' only at the last keystroke
    (continuous typing), or at every keystroke when eager=True (no debounce)."""
    cfg = run.cfg
    kptr = run.kept[0]
    seen, cmax, cfinal = set(), 0, 0
    for k in range(1, len(q) + 1):
        pre = q[:k]
        Q = R.query_tokens(pre)
        if not Q:
            continue
        final = k == len(q)
        files = run.idx.route(Q, cfg.get('mode', 'merged'), not pre.endswith(' '),
                              cfg.get('f_max', R.F_MAX), cfg.get('route'), paused=final or eager)
        seen.update(files)
        if files:
            c = len(EN.candidates(run.idx, run.kept, files))
        else:
            c = 0
        cmax = max(cmax, c)
        if final:
            cfinal = c
    return {'files': len(seen), 'kb': float(sum(kb[f] for f in seen)), 'cand_max': cmax,
            'cand_final': cfinal}


def cost_summary(costs):
    out = {}
    for k in ('files', 'kb', 'cand_max', 'cand_final'):
        v = np.array([c[k] for c in costs], dtype=float)
        out[k] = {'median': float(np.median(v)), 'p90': float(np.percentile(v, 90)), 'max': float(v.max())}
    return out


def cluster_bootstrap(results, n_boot=2000, seed=7, metrics_=('MRR', 'S@1', 'S@10')):
    """Clustered bootstrap over target entities, resampled jointly across ALL strata (a head
    item's label, aliases and typos move together). results: {system: result list}; all
    lists cover the same queries in the same order. Returns {system: {stratum|objective:
    {metric: (point, lo, hi)}}} plus paired deltas {'A - B': {...}} for every pair."""
    names = list(results)
    base = results[names[0]]
    ents = sorted(set(x['target'] for x in base))
    eidx = {e: i for i, e in enumerate(ents)}
    strata = [s for s in STRATA if any(x['stratum'] == s for x in base)]
    sidx = {s: i for i, s in enumerate(strata)}
    E, S = len(ents), len(strata)
    cnt = np.zeros((E, S))
    for x in base:
        cnt[eidx[x['target']], sidx[x['stratum']]] += 1
    val = {}
    for nm in names:
        for m in metrics_:
            a = np.zeros((E, S))
            for x in results[nm]:
                r = x['rank']
                v = {'MRR': (1.0 / r if r else 0.0), 'S@1': float(r == 1),
                     'S@10': float(bool(r) and r <= 10)}[m]
                a[eidx[x['target']], sidx[x['stratum']]] += v
            val[(nm, m)] = a
    rng = np.random.default_rng(seed)
    Wt = rng.multinomial(E, np.full(E, 1.0 / E), size=n_boot).astype(float)   # (B, E)
    den = Wt @ cnt                                                             # (B, S)

    def stats(num_b, point):
        lo, hi = np.percentile(num_b, [2.5, 97.5], axis=0)
        return point, lo, hi

    out = {}
    per = {}
    for nm in names:
        out[nm] = {}
        for m in metrics_:
            b = (Wt @ val[(nm, m)]) / np.maximum(den, 1e-9)                   # (B, S)
            p = val[(nm, m)].sum(0) / cnt.sum(0)
            per[(nm, m)] = (b, p)
            for s in strata:
                out[nm].setdefault(s, {})[m] = tuple(float(v) for v in stats(b[:, sidx[s]], p[sidx[s]]))
            out[nm].setdefault('objective', {})[m] = tuple(float(v) for v in stats(b.mean(1), p.mean()))
    for i, a in enumerate(names):
        for bn in names[i + 1:]:
            key = f'{a} - {bn}'
            out[key] = {}
            for m in metrics_:
                ba, pa = per[(a, m)]
                bb, pb = per[(bn, m)]
                for s in strata:
                    out[key].setdefault(s, {})[m] = tuple(float(v) for v in stats(
                        ba[:, sidx[s]] - bb[:, sidx[s]], pa[sidx[s]] - pb[sidx[s]]))
                out[key].setdefault('objective', {})[m] = tuple(float(v) for v in stats(
                    (ba - bb).mean(1), (pa - pb).mean()))
    return out
