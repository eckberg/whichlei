"""
Reference outputs for checking a TypeScript port against the Python ranking at full scale.
Data plumbing only: it runs the 'final' configuration of report.py (ranking.W_RECOMMENDED,
ranking.ROUTE, budget routing, per-shard cap, name types 0-3, no legal-form stripping) and
dumps what it does. No ranking logic lives here.

Run (after fetch_data.py and the prep steps; see run_all.sh):
    export DATA_DIR=/path/to/data
    python3 fetch_data.py --skip-wikidata
    # prep.py reads signals/wikidata.tsv, but W_RECOMMENDED has p_wikidata = 0, so a
    # header-only stub is enough when Wikidata is skipped:
    printf 'qid\tlei\tlabel_en\taliases_en\tsitelinks\tinstance_of\n' > $DATA_DIR/signals/wikidata.tsv
    python3 prep.py                            # cache/ rows, vocab, ents (prep_v2 is B0 only)
    python3 port/dump_parity.py
    node --max-old-space-size=12000 port/score.mjs $DATA_DIR/parity/cases_all.json

Outputs under $DATA_DIR/parity/ (not committed):
  names.jsonl     one line per distinct name string: [name, seq, extras] with
                  seq, extras = ranking.name_tokens(name). Names are every entity's legal
                  name plus every alternative name string the final configuration indexes
                  (sizes.load_alt_strings: trading, alternative-language and transliterated
                  names; previous legal names are not indexed).
  cases_all.json  same format as cases.json (see report.dump_js_cases), for every distinct query
                  in eval/{head,torso,tail,typo}.tsv, train and test. `top` is the Python
                  top 10; P is full precision.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

import engine as EN  # noqa: E402
import evaluate as EV  # noqa: E402
import ranking as R  # noqa: E402
import sizes as SZ  # noqa: E402
from paths import DATA_DIR  # noqa: E402
from report import cfg_final  # noqa: E402

OUT = os.path.join(DATA_DIR, 'parity')
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.0f}s]', *a, flush=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    W = dict(R.W_RECOMMENDED)
    run = EV.Runner(cfg_final(W))
    E = EN.ents()
    alt = SZ.load_alt_strings(run.idx)
    log(f'index: {run.idx.n_files} files, types {run.idx.types}; {len(E["name"]):,} entities, '
        f'{len(alt):,} with alt names')

    # names.jsonl
    seen, n_empty = set(), 0
    with open(os.path.join(OUT, 'names.jsonl'), 'w', encoding='utf-8') as f:
        def emit(name):
            nonlocal n_empty
            if name in seen:
                return
            seen.add(name)
            seq, ext = R.name_tokens(name)
            n_empty += not seq
            f.write(json.dumps([name, seq, ext], ensure_ascii=False, separators=(',', ':')) + '\n')
        for nm in E['name']:
            emit(nm)
        n_legal = len(seen)
        for lst in alt.values():
            for nm in lst:
                emit(nm)
    log(f'names.jsonl: {len(seen):,} distinct ({n_legal:,} legal, {len(seen) - n_legal:,} added from '
        f'alt strings), {n_empty} with empty seq')

    # cases_all.json
    rows = EV.load_eval()
    qs = list(dict.fromkeys(r['query'] for r in rows))
    log(f'{len(rows)} eval rows, {len(qs)} distinct queries')
    ents, out = {}, []
    for k, q in enumerate(qs):
        Q, files, Cd, top = run.query(q)
        for i in Cd:
            i = int(i)
            if i not in ents:
                ents[i] = [[E['name'][i]] + alt.get(i, []), float(run.P[i])]
        out.append(dict(q=q, cand=[int(i) for i in Cd], top=[int(i) for i in top]))
        if k % 500 == 0:
            log(f'  {k}/{len(qs)} queries, {len(ents):,} entities')
    with open(os.path.join(OUT, 'cases_all.json'), 'w') as f:
        json.dump(dict(W=W, ents=ents, queries=out), f, separators=(',', ':'))
    log(f'cases_all.json: {len(out)} queries, {len(ents):,} entities')


if __name__ == '__main__':
    main()
