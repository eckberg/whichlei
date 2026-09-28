"""
Reference ranking for the static-shard GLEIF typeahead.

Three parts, each a plain function so it can be ported to TypeScript line by line:

  1. prominence(ent, W)            static prior P(e); decides shard order AND which
                                    entries survive the per-file cap (first-stage recall)
  2. score_candidate(Q, entry, W)   query-time score = match(Q, names) + P(e)
  3. route_budget(Q, ...)           which shard file(s) to fetch, with bounded cost
                                    (route() keeps the first/longest/merged baselines)

Build-time helpers (tokenizer) are shared by the index builder and by the client, so the
same code must run on both sides. Legal-form stripping is implemented but OFF
(STRIP_LEGAL_FORMS): it was measured as no gain, so the client needs no ELF list.

Client flow (recommended configuration, see results.md):
  Q = query_tokens(typed text)                     # last token is a prefix
  files = route_budget(Q, bounds, capped,          # <= 2 words x 1 file, sticky per
                       last_is_prefix, paused)     #    word; cached; debounced
  entries = union of the fetched files' entries    # entry: [lei, legal name, country,
                                                   #         round(P*10), [alt names]]
  variants = name_tokens(legal name) and name_tokens(each alt name), core = (0, len)
  top_k(Q, entries, W_RECOMMENDED)                 # score = best name match + P
Build side: P = prominence(ent, W_RECOMMENDED) orders each shard file; a file is closed
before it exceeds 1,500 postings, so only single oversized words ("limited") are capped.

No numpy in this file on purpose. The evaluation harness (evaluate.py) has a vectorised
twin of score_candidate and cross-checks it against this one (see evaluate.py --selftest).
"""
import math
import re
import unicodedata

# --------------------------------------------------------------------------------------
# 1. Normalisation and tokenisation
# --------------------------------------------------------------------------------------

# NFKD does not decompose these, so fold them explicitly first.
FOLD = str.maketrans({
    'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'ł': 'l', 'Ł': 'l',
    'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'œ': 'oe', 'Œ': 'oe',
    'ı': 'i', 'ŋ': 'n', 'ħ': 'h', 'ŧ': 't',
})
ALNUM = re.compile(r'[a-z0-9]+')


def fold(s):
    s = s.translate(FOLD)
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def _merge_single_letters(runs):
    """['h', 'm', 'hennes'] -> ['hm', 'hennes'];  'L M Ericsson' -> ['lm', 'ericsson']."""
    out, i, n = [], 0, len(runs)
    while i < n:
        if len(runs[i]) == 1:
            j = i
            while j < n and len(runs[j]) == 1:
                j += 1
            out.append(''.join(runs[i:j]))
            i = j
        else:
            out.append(runs[i])
            i += 1
    return out


def name_tokens(name):
    """Tokens of an entity name.

    seq    : canonical token sequence. A chunk whose alnum runs are all <= 2 chars is
             joined ('AT&T' -> 'att', 'E.ON' -> 'eon', 'S.A.' -> 'sa'), exactly like
             query_tokens; adjacent single letters merge ('H & M' -> 'hm').
    extras : the other form of each multi-run chunk ('Coca-Cola' -> 'cocacola',
             'AT&T' -> 'at', 't'). Indexed and matched, but not positional.
    """
    runs_all, extras = [], []
    for chunk in fold(name).split():
        runs = ALNUM.findall(chunk)
        if not runs:
            continue
        if len(runs) >= 2 and all(len(r) <= 2 for r in runs):
            runs_all.append(''.join(runs))       # 'AT&T' -> 'att', 'S.A.' -> 'sa'
            extras.extend(runs)
        else:
            runs_all.extend(runs)
            if len(runs) >= 2:
                extras.append(''.join(runs))     # 'Coca-Cola' -> + 'cocacola'
    seq = _merge_single_letters(runs_all)
    seen = set(seq)
    extras = [x for x in dict.fromkeys(extras) if x not in seen and len(x) >= 2]
    return seq, extras


def query_tokens(q):
    """Tokens of a typed query. A chunk like 'h&m', 'at&t', 'e.on' (all runs <= 2 chars)
    becomes one joined token; 'coca-cola' stays two tokens. Then single letters merge."""
    toks = []
    for chunk in fold(q).split():
        runs = ALNUM.findall(chunk)
        if not runs:
            continue
        if len(runs) >= 2 and all(len(r) <= 2 for r in runs):
            toks.append(''.join(runs))
        else:
            toks.extend(runs)
    return _merge_single_letters(toks)


def index_terms(seq, extras):
    """Terms that place an entity into prefix shards (single characters are not indexed)."""
    return set(t for t in seq if len(t) >= 2) | set(t for t in extras if len(t) >= 2)


# --------------------------------------------------------------------------------------
# 2. Legal-form stripping -> core name
# --------------------------------------------------------------------------------------

# OPTIONAL (off in the recommended config): tested, no measurable gain.
# Legal-form vocabulary comes from the ELF code list (local names + abbreviations),
# as token phrases. Words that are ELF "names" but also common brand words are protected.
LF_PROTECT = {
    'bank', 'fund', 'fonds', 'fondo', 'trust', 'foundation', 'foundations', 'business',
    'series', 'multi', 'railroad', 'trademark', 'region', 'municipal', 'others', 'per',
    'institution', 'association', 'district', 'commune', 'canton', 'embassy',
    'congregation', 'confederation', 'syndicates', 'undivided', 'estado', 'sparkasse',
    'sparebank', 'sparbank', 'andelsbank', 'medlemsbank', 'osuuspankki', 'saastopankki',
    'kommune', 'kommun', 'gemeinde', 'comune', 'bund', 'kanton', 'ministere', 'region',
    'metropole', 'departement', 'municipio', 'municipalidad', 'sindicato', 'ente',
}
LF_EXTRA = [('the',), ('aktiebolaget',), ('publ',), ('group', 'plc'), ('holding', 'ag')]
LF_LEADING = {('the',), ('aktiebolaget',), ('ab',), ('as',), ('oy',), ('sa',)}


def load_legal_form_phrases(elf_tsv_path):
    phrases = set(LF_EXTRA)
    with open(elf_tsv_path, encoding='utf-8') as f:
        f.readline()
        for line in f:
            p = line.rstrip('\n').split('\t')
            for field in (p[3], p[4]):
                for nm in field.split(' | '):
                    seq, _ = name_tokens(nm)
                    if not seq or len(seq) > 6:
                        continue
                    if all(t in LF_PROTECT for t in seq):
                        continue
                    phrases.add(tuple(seq))
    return phrases


STRIP_LEGAL_FORMS = False   # recommended: core = full name (stripping measured as no gain)


def core_bounds(seq, lf_phrases=None):
    """Core-name range used by the scorer."""
    if not STRIP_LEGAL_FORMS or lf_phrases is None:
        return 0, len(seq)
    return core_range(seq, lf_phrases)


def core_range(seq, lf_phrases, max_phrase=6):
    """[cs, ce) of the core name: strip legal-form phrases at the end (repeatedly) and a
    few leading forms ('the', 'aktiebolaget'). Always keeps at least one token."""
    cs, ce = 0, len(seq)
    changed = True
    while changed and ce - cs > 1:
        changed = False
        for L in range(min(max_phrase, ce - cs - 1), 0, -1):
            if tuple(seq[ce - L:ce]) in lf_phrases:
                ce -= L
                changed = True
                break
    changed = True
    while changed and ce - cs > 1:
        changed = False
        for ph in LF_LEADING:
            L = len(ph)
            if ce - cs > L and tuple(seq[cs:cs + L]) == ph:
                cs += L
                changed = True
                break
    return cs, ce


# --------------------------------------------------------------------------------------
# 3. Static prominence P(e)
# --------------------------------------------------------------------------------------
# ent is a dict of raw attributes (see PROMINENCE_INPUTS). Weights live in W.
# Units: log1p counts, 0/1 flags. P is also the per-file cap order at build time.
#   n_direct / n_ultimate / n_branch : ACTIVE relationships where this LEI is the parent
#     (IS_DIRECTLY_ / IS_ULTIMATELY_CONSOLIDATED_BY, IS_INTERNATIONAL_BRANCH_OF);
#     fund-management, sub-fund and feeder links are deliberately NOT counted
#   has_parent    : the LEI reports a direct or an ultimate accounting parent
#   reg_age_years : golden-copy date minus InitialRegistrationDate, in years
#   name_len      : characters in the legal name

PROMINENCE_INPUTS = [
    'entity_status', 'registration_status', 'category', 'n_direct', 'n_ultimate',
    'n_branch', 'has_parent', 'isin', 'bic', 'reg_age_years',
    'name_len', 'sitelinks',
]

DEAD_REG = ('RETIRED', 'ANNULLED', 'DUPLICATE', 'MERGED')


def prominence(ent, W):
    p = 0.0
    if ent['entity_status'] != 'ACTIVE' or ent['registration_status'] in DEAD_REG:
        p += W['p_dead']
    elif ent['registration_status'] == 'LAPSED':
        p += W['p_lapsed']
    cat = ent['category']
    if cat == 'FUND':
        p += W['p_fund']
    elif cat in ('RESIDENT_GOVERNMENT_ENTITY', 'INTERNATIONAL_ORGANIZATION'):
        p += W['p_gov']
    n_consol = max(ent['n_direct'], ent['n_ultimate'])
    p += W['p_children'] * math.log1p(n_consol)
    if n_consol > 0 and not ent['has_parent']:
        p += W['p_top']
    if ent['has_parent']:
        p += W['p_has_parent']
    p += W['p_branches'] * math.log1p(ent['n_branch'])
    p += W['p_isin'] * min(math.log1p(ent['isin']), W['isin_cap'])
    if ent['bic']:
        p += W['p_bic']
    p += W['p_age'] * min(ent['reg_age_years'], 15.0) / 10.0
    p += W['p_len'] * math.log(max(ent['name_len'], 1))
    p += W.get('p_wikidata', 0.0) * math.log1p(ent.get('sitelinks', 0))
    return p


# --------------------------------------------------------------------------------------
# 4. Query-time match features and score
# --------------------------------------------------------------------------------------

FUZZY_MIN_LEN = 4   # query tokens shorter than this never match fuzzily
# Query words that are optional: an unmatched one is not a miss, and a name that matches
# only these words is not shown ('republic of latvia' must not surface 'Bank of America').
QUERY_STOP = {'the', 'of', 'and', 'de', 'du', 'des', 'la', 'le', 'les', 'der', 'die', 'das',
              'und', 'et', 'y', 'for', 'in', 'van', 'von', 'di', 'del', 'da', 'do', 'a', 'an'}


def prefix_edit_le1(q, t):
    """True if some prefix of t is within one edit (insert/delete/substitute/adjacent
    transpose) of q. Bounded DP; cheap because we stop as soon as distance > 1."""
    n, m = len(q), len(t)
    if m < n - 1:
        return False
    # classic Damerau (optimal string alignment) with rows over q, columns over t
    INF = 9
    prev2 = None
    prev = list(range(m + 1))          # distance of '' vs t[:j]
    for i in range(1, n + 1):
        cur = [i] + [INF] * m
        lo = max(1, i - 1)
        hi = min(m, i + 1)
        for j in range(lo, hi + 1):
            cost = 0 if q[i - 1] == t[j - 1] else 1
            d = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and q[i - 1] == t[j - 2] and q[i - 2] == t[j - 1]:
                d = min(d, prev2[j - 2] + 1)
            cur[j] = d
        prev2, prev = prev, cur
    # q fully consumed; any prefix t[:j] allowed
    return min(prev[max(0, n - 1):min(m, n + 1) + 1]) <= 1


def match_level(q, t):
    """3 exact word, 2 prefix, 1 fuzzy prefix (<= 1 edit), 0 none."""
    if t == q:
        return 3
    if t.startswith(q):
        return 2
    if len(q) >= FUZZY_MIN_LEN and prefix_edit_le1(q, t):
        return 1
    return 0


def match_features(Q, seq, extras, cs, ce):
    """Features of one name variant against query tokens Q (last token may be partial)."""
    n = len(Q)
    levels, pos = [], []
    for q in Q:
        best, bpos = 0, -1
        for j, t in enumerate(seq):
            lv = match_level(q, t)
            if lv > best:
                best, bpos = lv, j
        for t in extras:
            lv = match_level(q, t)
            if lv > best:
                best, bpos = lv, -1
        levels.append(best)
        pos.append(bpos)
    core = seq[cs:ce]
    # Q is a token-prefix of the core name ("volv" vs core "volvo" / "volvo car"),
    # or of the full name ("aktiebolaget vol")
    core_prefix = n <= len(core) and all(core[i] == Q[i] for i in range(n - 1)) \
        and core[n - 1].startswith(Q[n - 1])
    name_prefix = n <= len(seq) and all(seq[i] == Q[i] for i in range(n - 1)) \
        and seq[n - 1].startswith(Q[n - 1])
    # Q equals the core name or the full name, word for word
    exact = (n == len(core) and all(core[i] == Q[i] for i in range(n))) or \
        (n == len(seq) and all(seq[i] == Q[i] for i in range(n)))
    matched_core = set(p for p in pos if cs <= p < ce)
    stop = [q in QUERY_STOP for q in Q]
    content = [i for i in range(n) if not stop[i]] or list(range(n))
    return {
        'n': n,
        'shown': any(levels[i] > 0 for i in content),
        'n_miss': sum(1 for i in content if levels[i] == 0),
        'n_fuzzy': sum(1 for lv in levels if lv == 1),
        'n_exact': sum(1 for lv in levels if lv == 3),
        'core_exact': exact,
        'seq_prefix': core_prefix or name_prefix,
        'coverage': len(matched_core) / max(1, ce - cs),
    }


def match_score(f, W):
    if not f['shown']:
        return None                                  # no content token matches: not shown
    s = 0.0
    if f['n_miss'] == 0:
        s += W['m_all']
    s -= W['m_miss'] * f['n_miss']
    s -= W['m_fuzzy'] * f['n_fuzzy']
    s += W['m_exact'] * f['n_exact'] / f['n']
    if f['core_exact']:
        s += W['m_core_exact']
    if f['seq_prefix']:
        s += W['m_prefix']
    s += W['m_coverage'] * f['coverage']
    return s


def score_candidate(Q, entry, W):
    """entry: {'P': float, 'variants': [(seq, extras, cs, ce), ...]} -- the legal name
    and any indexed trading / alternative-language / transliterated names.
    Returns None when the entry does not match at all."""
    best = None
    for seq, extras, cs, ce in entry['variants']:
        m = match_score(match_features(Q, seq, extras, cs, ce), W)
        if m is None:
            continue
        if best is None or m > best:
            best = m
    return None if best is None else best + entry['P']


# --------------------------------------------------------------------------------------
# 5. Routing
# --------------------------------------------------------------------------------------
# table.bounds: sorted list with the first term of every shard file (binary search).
# A complete token (followed by a space) fetches the one file that holds that term.
# The last token is a prefix: fetch the files spanning [tok, tok + '\uffff'),
# at most F_MAX of them (the first ones: they hold the exact term and short completions).

F_MAX = 2


def _file_of(bounds, term):
    lo, hi = 0, len(bounds)
    while lo < hi:
        mid = (lo + hi) // 2
        if bounds[mid] <= term:
            lo = mid + 1
        else:
            hi = mid
    return max(0, lo - 1)


def files_for_token(bounds, tok, is_prefix, f_max=F_MAX):
    first = _file_of(bounds, tok)
    if not is_prefix:
        return [first]
    last = _file_of(bounds, tok + '\uffff')
    return list(range(first, min(last, first + f_max - 1) + 1))


def route(Q, bounds, mode='merged', last_is_prefix=True, f_max=F_MAX):
    """mode: 'first' | 'longest' | 'merged' (fetch every token's files, union)."""
    if not Q:
        return []
    toks = [(q, last_is_prefix and i == len(Q) - 1) for i, q in enumerate(Q)]
    if mode == 'first':
        pick = [toks[0]]
    elif mode == 'longest':
        pick = [max(toks, key=lambda x: len(x[0]))]     # ties -> earliest
    else:
        pick = toks
    out = []
    for q, pre in pick:
        for f in files_for_token(bounds, q, pre, f_max):
            if f not in out:
                out.append(f)
    return out


# ---- Cost-bounded routing (recommended) -------------------------------------------------
# The routing table carries, per file, its first term (bounds) and one bit: capped = the
# file is a single oversized word whose entries were cut to the top 1,500 by P.
#
#  * A word is only routed once it has >= min_chars characters.
#  * Sticky anchor prefix: a word's files are the files spanned by the SHORTEST prefix of
#    it (>= min_chars) whose prefix range spans <= max_span files. Prefix ranges nest, so
#    these files are fetched once while typing and stay valid for every longer prefix,
#    for the completed word, and for typos made after that prefix.
#  * A word that never narrows that far ("international") routes to the one file that
#    holds the word itself: always once it is complete; while it is still being typed only
#    on a pause (debounce), unless wide='eager'.
#  * At most max_anchors words are routed per query, preferring words whose fetched files
#    hold every entity containing the word (full coverage: narrow range, nothing capped),
#    then longer words. Stopwords are never routed.
# Candidates = union of the routed files' entries, so candidates <= 1,500 x max_span x
# max_anchors by construction.

ROUTE = {'min_chars': 3, 'max_span': 1, 'max_anchors': 2, 'wide': 'pause', 'short_single': True}


def prefix_files(bounds, p):
    return _file_of(bounds, p), _file_of(bounds, p + '\uffff')


def word_files(bounds, capped, w, in_progress, paused, params=ROUTE):
    """-> (files, full_coverage) for one query word."""
    mc, K = params['min_chars'], params['max_span']
    if len(w) < mc:
        return [], False
    for L in range(mc, len(w) + 1):
        a, b = prefix_files(bounds, w[:L])
        if b - a + 1 <= K:
            fs = list(range(a, b + 1))
            return fs, not any(capped[f] for f in fs)
    if in_progress and not paused and params['wide'] != 'eager':
        return [], False
    f = _file_of(bounds, w)
    return [f], (not in_progress) and not capped[f]


def route_budget(Q, bounds, capped, last_is_prefix=True, paused=True, params=ROUTE):
    """Files to fetch for query tokens Q. paused=False models continuous typing (the
    in-progress word is not yet debounced)."""
    cands = []
    for i, q in enumerate(Q):
        if q in QUERY_STOP:
            continue
        in_prog = last_is_prefix and i == len(Q) - 1
        fs, full = word_files(bounds, capped, q, in_prog, paused, params)
        if fs:
            cands.append((0 if full else 1, -len(q), i, fs))
    if not cands and params['short_single'] and len(Q) == 1 and len(Q[0]) >= 2 and paused:
        return [_file_of(bounds, Q[0])]          # 'bp', '3m': one file, only on a pause
    cands.sort()
    out = []
    for _, _, _, fs in cands[:params['max_anchors']]:
        for f in fs:
            if f not in out:
                out.append(f)
    return out


def top_k(Q, entries, W, k=10):
    scored = []
    for e in entries:
        s = score_candidate(Q, e, W)
        if s is not None:
            scored.append((-s, e['id'], e))
    scored.sort(key=lambda x: (x[0], x[1]))
    return [e for _, _, e in scored[:k]]


# --------------------------------------------------------------------------------------
# 6. Weights
# --------------------------------------------------------------------------------------
# Recommended: conditional-logit fit on the train split (fit_logit.py v2main): budget
# routing (ROUTE), legal + trading + alternative-language + transliterated names,
# no legal-form stripping, p_gov fixed at 0, lambda 0.001 by 2-fold CV inside train.
# Rounded to 2 decimals. score = best name match + P.

W_RECOMMENDED = {
    'p_dead': -2.9,         # entity INACTIVE or registration RETIRED/ANNULLED/DUPLICATE/MERGED
    'p_lapsed': -0.39,      # registration LAPSED
    'p_fund': 0.32,         # category FUND (small; sign is a product call)
    'p_gov': 0.0,           # FIXED at 0: a boost only reflected the Wikidata head sample
    'p_children': 0.5,      # x log1p(max(direct, ultimate) consolidated children)
    'p_top': 1.36,          # has consolidated children and no parent
    'p_has_parent': -0.56,
    'p_branches': -0.91,    # x log1p(international branches)
    'p_isin': 0.49,         # x min(log1p(ISIN count), isin_cap)
    'isin_cap': 3.932,      # = log1p(50)
    'p_bic': 0.74,
    'p_age': 2.46,          # x min(years since LEI registration, 15) / 10
    'p_len': -1.01,         # x ln(legal name length in chars)
    'p_wikidata': 0.0,      # optional, see W_WIKIDATA
    'm_all': 2.59,          # every content word matched
    'm_miss': 4.83,         # per unmatched content word
    'm_fuzzy': 1.19,        # per word matched only within one edit
    'm_exact': 2.96,        # x share of query words equal to a whole name word
    'm_core_exact': 0.55,   # query == name, word for word
    'm_prefix': 0.84,       # query is a word-prefix of the name
    'm_coverage': 2.26,     # x share of name words matched
}

# Optional: same model refitted with Wikidata sitelinks (inflates head by construction).
W_WIKIDATA = {
    'p_dead': -2.49,        # entity INACTIVE or registration RETIRED/ANNULLED/DUPLICATE/MERGED
    'p_lapsed': -0.2,       # registration LAPSED
    'p_fund': 1.07,         # category FUND (small; sign is a product call)
    'p_gov': 0.0,           # FIXED at 0: a boost only reflected the Wikidata head sample
    'p_children': -0.23,    # x log1p(max(direct, ultimate) consolidated children)
    'p_top': 1.29,          # has consolidated children and no parent
    'p_has_parent': 0.24,
    'p_branches': -1.19,    # x log1p(international branches)
    'p_isin': 0.19,         # x min(log1p(ISIN count), isin_cap)
    'isin_cap': 3.932,      # = log1p(50)
    'p_bic': 0.22,
    'p_age': 0.21,          # x min(years since LEI registration, 15) / 10
    'p_len': -0.27,         # x ln(legal name length in chars)
    'p_wikidata': 1.85,     # optional, see W_WIKIDATA
    'm_all': 3.11,          # every content word matched
    'm_miss': 3.3,          # per unmatched content word
    'm_fuzzy': 0.38,        # per word matched only within one edit
    'm_exact': 4.04,        # x share of query words equal to a whole name word
    'm_core_exact': 0.89,   # query == name, word for word
    'm_prefix': 2.18,       # query is a word-prefix of the name
    'm_coverage': 1.2,      # x share of name words matched
}

# Starting point for tuning only (not recommended).
W_DEFAULT = {
    'p_dead': -6.0, 'p_lapsed': -1.0, 'p_fund': -1.0, 'p_branch_cat': -1.0, 'p_sole': -1.0,
    'p_gov': 0.0, 'p_children': 1.0, 'p_top': 1.0, 'p_has_parent': -0.5,
    'p_branches': 0.5, 'p_managed': 0.0, 'p_isin': 0.5, 'isin_cap': math.log1p(50),
    'p_bic': 1.0, 'p_age': 0.5, 'p_len': -1.0, 'p_wikidata': 0.0,
    'm_all': 4.0, 'm_miss': 3.0, 'm_fuzzy': 2.0, 'm_exact': 1.0, 'm_core_exact': 4.0,
    'm_prefix': 2.0, 'm_coverage': 2.0, 'm_order': 0.5, 'm_alt': 0.5,
}
