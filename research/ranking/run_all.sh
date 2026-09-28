#!/bin/bash
# Reproduce the whole study in one run (about 40-75 min on 4 cores).
#
# Inputs: DATA_DIR (env var; default research/data, next to this directory) with the
# GLEIF golden-copy files and the built signal TSVs. See fetch_data.py to build it.
# Needs: python3 with numpy + scipy (requirements.txt); node (for the JS timing only).
#
# SKIP_B1=1        skip the GLEIF API baseline (network, 1 request/second, ~4 min)
# REBUILD_EVAL=1   rebuild eval/*.tsv from signals + Wikidata instead of using the
#                  committed copies (not exactly reproducible: Wikidata is live)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p cache logs eval port
D=m_order,p_managed,p_branch_cat,m_alt,p_sole,p_gov     # weights fixed at 0 (pruned; p_gov: see results)
exec 3>&1
t() { local s=$(date +%s); "$@"; echo "  ok $(( $(date +%s) - s ))s :: $*" >&3; }

# 1. parse + tokenise once (caches in cache/)
t python3 prep.py > logs/prep.log 2>&1
t python3 prep_v2.py > logs/prep_v2.log 2>&1
rm -f cache/index_*.pkl cache/filekb_*.npy          # derived from the rows above
# 2. evaluation set: eval/*.tsv is committed and used as-is by default (see above)
[ "${REBUILD_EVAL:-0}" = 1 ] && t python3 build_eval.py > logs/build_eval.log 2>&1
[ "${SKIP_B1:-0}" = 1 ] || t python3 b1_gleif.py > logs/b1.log 2>&1
# 3. decisions, TRAIN split only (2-fold CV inside train)
#    provisional weights under merged routing -> routing grid (choice recorded in ranking.ROUTE)
t python3 fit_logit.py v2merged --init '' --nocore --mode merged --drop $D --lams 0.001 \
    --write cache/weights_merged.json > logs/logit_v2merged.log 2>&1
t python3 route_grid.py cache/weights_merged.json cache/route_grid.jsonl > logs/route_grid.log 2>&1
#    final weights under the chosen routing -> cache/final.json (== ranking.W_RECOMMENDED)
t python3 fit_logit.py v2main --init '' --nocore --mode budget --drop $D --lams 0.001,0.003,0.01 \
    --write cache/final.json > logs/logit_v2main.log 2>&1
t python3 fit_logit.py v2wd --init '' --nocore --wikidata --mode budget --drop $D --lams 0.001 \
    --write cache/final_wikidata.json > logs/logit_v2wd.log 2>&1
#    structural checks (CV): names indexed, fuzzy, legal-form stripping
t python3 fit_logit.py v2legal --init '' --nocore --mode budget --types 0 --drop $D --lams 0.001 > logs/logit_v2legal.log 2>&1
t python3 fit_logit.py v2prev --init '' --nocore --mode budget --types 01234 --drop $D --lams 0.001 > logs/logit_v2prev.log 2>&1
t python3 fit_logit.py v2nofuzzy --init '' --nocore --nofuzzy --mode budget --drop $D,m_fuzzy --lams 0.001 > logs/logit_v2nofuzzy.log 2>&1
t python3 fit_logit.py v2strip --init '' --mode budget --drop $D --lams 0.001 > logs/logit_v2strip.log 2>&1
t python3 sync_weights.py > logs/sync_weights.log 2>&1     # fitted weights -> ranking.py
python3 -c "
import json, sys; sys.path.insert(0, '.'); import ranking as R
W = json.load(open('cache/final.json'))['W']
bad = {k: (W[k], v) for k, v in R.W_RECOMMENDED.items() if W[k] != v}
print('final.json == ranking.W_RECOMMENDED' if not bad else f'MISMATCH {bad}')"
t python3 report.py train > logs/report_train.log 2>&1
# 4. reference scorer == vectorised engine
t python3 evaluate.py --selftest > logs/selftest.log 2>&1
# 5. TEST split, once
t python3 report.py test > logs/report_test.log 2>&1
command -v node >/dev/null && node port/score.mjs port/cases.json > logs/js_timing.log 2>&1 || true
echo "ALL DONE"
