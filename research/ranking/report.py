"""
Every number in results.md. Two parts:
  python3 report.py train   decisions and ablations on the TRAIN split
  python3 report.py test    the final configuration on TEST, run once
Output: cache/report_<part>.json and a printed summary (logs/report_<part>.log).
CIs: clustered bootstrap over target entities, resampled jointly across all strata.
"""
import collections
import json
import sys
import time

import numpy as np

import engine as EN
import evaluate as EV
import ranking as R
import sizes as SZ
from paths import PORT

C = EN.CACHE
POST = {'file_postings': EN.CAP}
HEADISH = ('head_label', 'head_alias', 'typo_first3', 'typo_later')
T0 = time.time()
OUT = {}


def log(*a):
    print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)


def nogov(res):
    return [x for x in res if not (x['stratum'] in HEADISH and x['kind'] == 'gov')]


def cfg_final(W, **kw):
    return dict(dict(W=W, types=(0, 1, 2, 3), mode='budget', route=dict(R.ROUTE), index_kw=POST,
                     strip=False), **kw)


def table(ms):
    return {s: {k: ms[s][k] for k in ('n', 'S@1', 'S@5', 'S@10', 'MRR', 'inshard')} for s in ms}


def show(name, res):
    ms = EV.by_stratum(res)
    log(f'--- {name}: obj {EV.objective(ms):.4f}')
    for s in EV.STRATA:
        if s in ms:
            m = ms[s]
            log(f'     {s:12s} n={m["n"]:4d} S@1 {m["S@1"]:.3f} S@5 {m["S@5"]:.3f} S@10 {m["S@10"]:.3f} '
                f'MRR {m["MRR"]:.3f} in-shard {m["inshard"]:.3f}')
    return table(ms)


def ci_line(ci, key):
    p, lo, hi = ci[key]['objective']['MRR']
    return f'{p:.3f} [{lo:.3f}, {hi:.3f}]'


def part_train():
    W = json.load(open(C + 'final.json'))['W']
    rows = [r for r in EV.load_eval() if r['split'] == 'train']
    res = EV.Runner(cfg_final(W)).evaluate(rows)
    OUT['final_train'] = show('final (train)', res)
    groups = {
        'all prominence (P = 0)': [k for k in W if k.startswith('p_')],
        'status (dead, lapsed)': ['p_dead', 'p_lapsed'],
        'consolidation children + top parent': ['p_children', 'p_top'],
        'has parent': ['p_has_parent'], 'intl branches': ['p_branches'],
        'ISIN count': ['p_isin'], 'BIC': ['p_bic'], 'registration age': ['p_age'],
        'name length': ['p_len'], 'FUND category': ['p_fund'],
        'all-words-matched bonus': ['m_all'], 'exact-word share': ['m_exact'],
        'exact name': ['m_core_exact'], 'word-prefix of name': ['m_prefix'],
        'coverage': ['m_coverage'], 'fuzzy penalty': ['m_fuzzy'],
    }
    results = {'final': res}
    for name, keys in groups.items():
        results[name] = EV.Runner(cfg_final(dict(W, **{k: 0.0 for k in keys}))).evaluate(rows)
    ci = EV.cluster_bootstrap(results, metrics_=('MRR',))
    OUT['ablation_train'] = {}
    for name in groups:
        d = ci[f'final - {name}']['objective']['MRR']
        dn = (EV.objective(EV.by_stratum(nogov(results['final'])))
              - EV.objective(EV.by_stratum(nogov(results[name]))))
        per = {s: ci[f'final - {name}'][s]['MRR'][0] for s in EV.STRATA}
        OUT['ablation_train'][name] = {'delta': d, 'delta_nogov': dn, 'per_stratum': per}
        log(f'  ablation (train) -{name:36s} Δobj {-d[0]:+.4f} [{-d[2]:+.4f},{-d[1]:+.4f}]  '
            f'no-gov {-dn:+.4f}  ' + ' '.join(f'{s[:9]}={-v:+.3f}' for s, v in per.items()))
    heads = [r for r in rows if r['stratum'] == 'head_label']
    OUT['keystrokes_train'] = {}
    for name, c in (('budget (chosen)', cfg_final(W)), ('merged', cfg_final(W, mode='merged'))):
        k = EV.keystroke_summary(EV.keystrokes(EV.Runner(c), heads))
        OUT['keystrokes_train'][name] = k
        log(f'  keystrokes train {name}: {k}')
    json.dump(OUT, open(C + 'report_train.json', 'w'), indent=1, default=float)
    log('DONE')


def part_test():
    W = json.load(open(C + 'final.json'))['W']
    Wwd = json.load(open(C + 'final_wikidata.json'))['W']
    rows = EV.load_eval()
    test = [r for r in rows if r['split'] == 'test']
    systems = {
        'B0 baseline (as built)': dict(b0=True),
        'final ranking, as-built packing': cfg_final(W, index_kw={}),
        'final': cfg_final(W),
    }
    runs, res = {}, {}
    for name, c in systems.items():
        runs[name] = EV.Runner(c)
        res[name] = runs[name].evaluate(test)
        OUT.setdefault('main', {})[name] = show(name + ' | test', res[name])
        OUT.setdefault('main_nogov', {})[name] = table(EV.by_stratum(nogov(res[name])))
        log(f'     without governments in head strata: obj {EV.objective(EV.by_stratum(nogov(res[name]))):.4f}')
    ci = EV.cluster_bootstrap(res, metrics_=('MRR', 'S@1', 'S@10'))
    ci_ng = EV.cluster_bootstrap({k: nogov(v) for k, v in res.items()}, metrics_=('MRR', 'S@1'))
    OUT['ci'], OUT['ci_nogov'] = ci, ci_ng
    for k in list(res) + ['B0 baseline (as built) - final', 'final ranking, as-built packing - final']:
        log(f'  CI objective {k:45s} all {ci_line(ci, k)}  no-gov {ci_line(ci_ng, k)}')
    log('  per-stratum S@1 CI (final):', {s: tuple(round(v, 3) for v in ci['final'][s]['S@1']) for s in EV.STRATA})
    log('  per-stratum MRR CI (final):', {s: tuple(round(v, 3) for v in ci['final'][s]['MRR']) for s in EV.STRATA})
    rtr = EV.Runner(cfg_final(W)).evaluate([r for r in rows if r['split'] == 'train'])
    OUT['gap'] = {'train': EV.objective(EV.by_stratum(rtr)), 'test': EV.objective(EV.by_stratum(res['final'])),
                  'train_nogov': EV.objective(EV.by_stratum(nogov(rtr))),
                  'test_nogov': EV.objective(EV.by_stratum(nogov(res['final']))),
                  'train_mrr': {s: m['MRR'] for s, m in EV.by_stratum(rtr).items()}}
    log('  gap', OUT['gap'])
    fr = res['final']
    for kind in ('company', 'gov'):
        OUT.setdefault('head_kind', {})[kind] = EV.metrics(
            [x for x in fr if x['stratum'] == 'head_label' and x['kind'] == kind])
    OUT['lenient'] = {st: EV.metrics([x for x in fr if x['stratum'] == st]) for st in ('head_label', 'head_alias')}
    OUT['torso_k'] = {q: EV.metrics([x for x in fr if x['stratum'] == 'torso' and x['qtype'] == q])
                      for q in ('words1', 'words2')}
    log('  head kind', {k: (round(v['S@1'], 3), round(v['MRR'], 3)) for k, v in OUT['head_kind'].items()},
        'lenient', {k: (round(v['S@1'], 3), round(v['lenS@1'], 3)) for k, v in OUT['lenient'].items()},
        'torso', {k: round(v['S@1'], 3) for k, v in OUT['torso_k'].items()})
    E = EN.ents()
    govcat = {E['CAT'].index(c) for c in ('RESIDENT_GOVERNMENT_ENTITY', 'INTERNATIONAL_ORGANIZATION')}
    rg = EV.Runner(cfg_final(dict(W, p_gov=2.68))).evaluate(test)
    for name, rr in (('final (p_gov 0)', fr), ('same weights with p_gov 2.68', rg)):
        comp = [x for x in rr if x['kind'] == 'company']
        g1 = sum(1 for x in comp if x['top'] and int(E['cat'][x['top'][0]]) in govcat)
        OUT.setdefault('gov_at_1', {})[name] = [g1, len(comp)]
        OUT.setdefault('gov_obj', {})[name] = [EV.objective(EV.by_stratum(rr)), EV.objective(EV.by_stratum(nogov(rr)))]
        log(f'  government at #1 on company-target queries, {name}: {g1}/{len(comp)}; '
            f'obj all/no-gov {OUT["gov_obj"][name]}')
    b1 = EV.b1_results()  # {} when b1_gleif.py was skipped (SKIP_B1=1)
    sample = [l.rstrip('\n').split('\t') for l in open(EV.EVAL + 'b1_sample.tsv', encoding='utf-8')][1:]
    byq = {r['query']: r for r in test if r['stratum'] == 'head_label'}
    srows = [byq[s[0]] for s in sample]
    OUT['b1'] = {ep: EV.metrics(v) for ep, v in b1.items()}
    OUT['b1']['B0'] = EV.metrics(runs['B0 baseline (as built)'].evaluate(srows))
    OUT['b1']['final'] = EV.metrics(runs['final'].evaluate(srows))
    for k, m in OUT['b1'].items():
        log(f'  B1 sample {k:18s} S@1 {m["S@1"]:.2f} S@5 {m["S@5"]:.2f} S@10 {m["S@10"]:.2f} MRR {m["MRR"]:.3f}')
    if not b1:
        log('  B1 (GLEIF API): skipped (SKIP_B1=1) -- no eval/b1_raw.jsonl to compare against')
    kb = EV.file_kb(runs['final'])
    OUT['cost'] = {}
    for name, run in (('final (budget routing)', runs['final']),
                      ('merged routing (previous)', EV.Runner(cfg_final(W, mode='merged')))):
        OUT['cost'][name] = {
            'typed_debounced': EV.cost_summary([EV.session_cost(run, r['query'], kb) for r in test]),
            'typed_eager': EV.cost_summary([EV.session_cost(run, r['query'], kb, eager=True) for r in test])}
        c = OUT['cost'][name]
        log(f'  cost {name}: typed files {c["typed_debounced"]["files"]}  KB {c["typed_debounced"]["kb"]}  '
            f'cand_max {c["typed_debounced"]["cand_max"]}  | eager KB {c["typed_eager"]["kb"]} '
            f'cand_max {c["typed_eager"]["cand_max"]}')
    heads = [r for r in test if r['stratum'] == 'head_label']
    OUT['keystrokes'] = {}
    for name, run in (('B0 baseline (as built)', runs['B0 baseline (as built)']), ('final', runs['final'])):
        OUT['keystrokes'][name] = EV.keystroke_summary(EV.keystrokes(run, heads))
        log(f'  keystrokes {name}: {OUT["keystrokes"][name]}')
    comp = [r for r in heads if r['kind'] == 'company']
    OUT['keystrokes']['final, companies'] = EV.keystroke_summary(EV.keystrokes(runs['final'], comp))
    log(f'  keystrokes final companies: {OUT["keystrokes"]["final, companies"]}')
    for pack, kw in (('as built', {}), ('per-shard cap', POST)):
        idx = EV.get_index('v3', (0, 1, 2, 3), **kw)
        kept = idx.cap(EN.prominence(W))
        OUT.setdefault('reach', {})[pack] = dict(files=idx.n_files, entities=int(np.unique(kept[1]).size))
    b0r = runs['B0 baseline (as built)']
    OUT['reach']['B0'] = dict(files=b0r.idx.n_files, entities=int(np.unique(b0r.kept[1]).size))
    log('  reachable entities', OUT['reach'])
    rw = EV.Runner(cfg_final(Wwd)).evaluate(test)
    ciw = EV.cluster_bootstrap({'final': fr, 'wikidata': rw}, metrics_=('MRR', 'S@1'))
    OUT['wikidata'] = {'test': table(EV.by_stratum(rw)), 'ci': ciw['final - wikidata'],
                       'obj': EV.objective(EV.by_stratum(rw)),
                       'nogov_obj': EV.objective(EV.by_stratum(nogov(rw))), 'p_wikidata': Wwd['p_wikidata']}
    log(f'  wikidata on: obj {OUT["wikidata"]["obj"]:.4f} (final - wikidata {ci_line(ciw, "final - wikidata")}), '
        f'head S@1 {OUT["wikidata"]["test"]["head_label"]["S@1"]:.3f}, torso MRR {OUT["wikidata"]["test"]["torso"]["MRR"]:.3f}')
    OUT['misses'] = [dict(stratum=x['stratum'], query=x['query'], target=x['name'], rank=x['rank'],
                          in_shard=x['in_shard'], top1=E['name'][x['top'][0]] if x['top'] else None)
                     for x in fr if x['rank'] != 1]
    cnt = collections.Counter((x['stratum'], 'not fetched' if not x['in_shard'] else
                               ('rank>10' if x['rank'] is None else 'rank 2-10')) for x in fr if x['rank'] != 1)
    OUT['miss_counts'] = {f'{a}|{b}': v for (a, b), v in sorted(cnt.items())}
    log('  misses', OUT['miss_counts'])
    dump_js_cases(runs['final'], W, test)
    json.dump(OUT, open(C + 'report_test.json', 'w'), indent=1, default=float)
    log('DONE')


def dump_js_cases(run, W, test):
    """Input for port/score.mjs: 250 random test queries + the 20 with most candidates."""
    E = EN.ents()
    alt = SZ.load_alt_strings(run.idx)
    rng = np.random.default_rng(3)
    qs = [test[i]['query'] for i in rng.choice(len(test), 250, replace=False)]
    heavy = sorted(test, key=lambda r: -len(run.query(r['query'])[2]))[:20]
    qs += [r['query'] for r in heavy]
    ents, out = {}, []
    for q in qs:
        Q, files, Cd, top = run.query(q)
        for i in Cd:
            i = int(i)
            ents[i] = [[E['name'][i]] + alt.get(i, []), float(run.P[i])]
        out.append(dict(q=q, cand=[int(i) for i in Cd], top=[int(i) for i in top]))
    json.dump(dict(W=W, ents=ents, queries=out), open(PORT + 'cases.json', 'w'))
    log(f'  JS cases: {len(out)} queries, {len(ents)} entities')


if __name__ == '__main__':
    part_train() if sys.argv[1] == 'train' else part_test()
