"""Write cache/final.json and cache/final_wikidata.json into ranking.py's W_RECOMMENDED and
W_WIKIDATA blocks, so the reference implementation always carries the fitted weights."""
import json
import re

from paths import CACHE, RANKING_PY

RK = RANKING_PY
C = CACHE
KEYS = ['p_dead', 'p_lapsed', 'p_fund', 'p_gov', 'p_children', 'p_top', 'p_has_parent', 'p_branches',
        'p_isin', 'isin_cap', 'p_bic', 'p_age', 'p_len', 'p_wikidata', 'm_all', 'm_miss', 'm_fuzzy',
        'm_exact', 'm_core_exact', 'm_prefix', 'm_coverage']
NOTE = {
    'p_dead': 'entity INACTIVE or registration RETIRED/ANNULLED/DUPLICATE/MERGED',
    'p_lapsed': 'registration LAPSED', 'p_fund': 'category FUND (small; sign is a product call)',
    'p_gov': 'FIXED at 0: a boost only reflected the Wikidata head sample',
    'p_children': 'x log1p(max(direct, ultimate) consolidated children)',
    'p_top': 'has consolidated children and no parent', 'p_branches': 'x log1p(international branches)',
    'p_isin': 'x min(log1p(ISIN count), isin_cap)', 'isin_cap': '= log1p(50)',
    'p_age': 'x min(years since LEI registration, 15) / 10', 'p_len': 'x ln(legal name length in chars)',
    'p_wikidata': 'optional, see W_WIKIDATA', 'm_all': 'every content word matched',
    'm_miss': 'per unmatched content word', 'm_fuzzy': 'per word matched only within one edit',
    'm_exact': 'x share of query words equal to a whole name word',
    'm_core_exact': 'query == name, word for word', 'm_prefix': 'query is a word-prefix of the name',
    'm_coverage': 'x share of name words matched'}


def block(name, W):
    lines = []
    for k in KEYS:
        s = f"    '{k}': {W[k]!r},"
        lines.append((s.ljust(28) + '# ' + NOTE[k]) if k in NOTE else s)
    return f'{name} = {{\n' + '\n'.join(lines) + '\n}\n'


src = open(RK, encoding='utf-8').read()
for name, path in (('W_RECOMMENDED', 'final.json'), ('W_WIKIDATA', 'final_wikidata.json')):
    W = json.load(open(C + path))['W']
    src, n = re.subn(rf'^{name} = \{{\n.*?^\}}\n', block(name, W), src, count=1, flags=re.S | re.M)
    assert n == 1, name
lam = json.load(open(C + 'final.json'))['lambda']
src = re.sub(r'p_gov fixed at 0, lambda [0-9.e-]+ by', f'p_gov fixed at 0, lambda {lam} by', src)
open(RK, 'w', encoding='utf-8').write(src)
print('ranking.py weights synced from', C + 'final.json')
