"""
Vectorised evaluation engine: static shard index, per-file cap, routing and the
query-time scorer. Mirrors ranking.py (checked by evaluate.py --selftest).

Shard build: index terms sorted; group by 2-char prefix; a prefix with > SPLIT
postings splits one character deeper (max depth 14; the word equal to the prefix
stays at the node); consecutive shards are packed into files until a file holds > 900
words; each file keeps its CAP highest-P entities (ties -> lower entity id).
"""
import bisect
import math
import os
import pickle
import time

import numpy as np

import ranking as R
from paths import CACHE

SPLIT, MAXDEPTH, WORDS_PER_FILE, CAP = 1500, 14, 900, 1500
NOW_YEAR = 2026.74          # golden copy 2026-09-16

_E = None


def ents():
    global _E
    if _E is None:
        E = dict(np.load(CACHE + 'ents.npz'))
        S = pickle.load(open(CACHE + 'ents_str.pkl', 'rb'))
        E.update(S)
        E['lei2id'] = {l: i for i, l in enumerate(S['lei'])}
        _E = E
    return _E


# ----------------------------------------------------------------------------------
# Prominence (numpy twin of ranking.prominence)
# ----------------------------------------------------------------------------------
def prominence_features():
    E = ents()
    if 'PF' in E:
        return E['PF']
    RS, CAT, RT = E['RS'], E['CAT'], E['rel_types']
    rs, es, cat, rel = E['rs'], E['es'], E['cat'], E['rel']
    dead = (es != 1) | np.isin(rs, [RS.index(x) for x in R.DEAD_REG if x in RS])
    lapsed = ~dead & (rs == RS.index('LAPSED'))
    ndir = rel[:, RT.index('IS_DIRECTLY_CONSOLIDATED_BY')]
    nult = rel[:, RT.index('IS_ULTIMATELY_CONSOLIDATED_BY')]
    ncons = np.maximum(ndir, nult)
    hasp = (E['hasp'][:, 0] > 0) | (E['hasp'][:, 1] > 0)
    age = np.nan_to_num(NOW_YEAR - E['regy'], nan=0.0).clip(0, 15)
    PF = {
        'dead': dead.astype(np.float32),
        'lapsed': lapsed.astype(np.float32),
        'fund': (cat == CAT.index('FUND')).astype(np.float32),
        'branch_cat': (cat == CAT.index('BRANCH')).astype(np.float32),
        'sole': (cat == CAT.index('SOLE_PROPRIETOR')).astype(np.float32),
        'gov': np.isin(cat, [CAT.index('RESIDENT_GOVERNMENT_ENTITY'),
                             CAT.index('INTERNATIONAL_ORGANIZATION')]).astype(np.float32),
        'children': np.log1p(ncons).astype(np.float32),
        'top': ((ncons > 0) & ~hasp).astype(np.float32),
        'has_parent': hasp.astype(np.float32),
        'branches': np.log1p(rel[:, RT.index('IS_INTERNATIONAL_BRANCH_OF')]).astype(np.float32),
        'managed': np.log1p(rel[:, RT.index('IS_FUND-MANAGED_BY')]).astype(np.float32),
        'isin_log': np.log1p(E['isin']).astype(np.float32),
        'bic': E['bic'].astype(np.float32),
        'age': (age / 10.0).astype(np.float32),
        'len': np.log(np.maximum(E['name_len'], 1)).astype(np.float32),
        'wikidata': np.log1p(E['sitelinks']).astype(np.float32),
    }
    E['PF'] = PF
    return PF


def prominence(W):
    F = prominence_features()
    P = (W['p_dead'] * F['dead'] + W['p_lapsed'] * F['lapsed'] + W['p_fund'] * F['fund']
         + W.get('p_branch_cat', 0.0) * F['branch_cat'] + W.get('p_sole', 0.0) * F['sole'] + W['p_gov'] * F['gov']
         + W['p_children'] * F['children'] + W['p_top'] * F['top']
         + W['p_has_parent'] * F['has_parent'] + W['p_branches'] * F['branches']
         + W.get('p_managed', 0.0) * F['managed']
         + W['p_isin'] * np.minimum(F['isin_log'], W['isin_cap'])
         + W['p_bic'] * F['bic'] + W['p_age'] * F['age'] + W['p_len'] * F['len']
         + W.get('p_wikidata', 0.0) * F['wikidata'])
    return P.astype(np.float64)


def prominence_b0():
    """The baseline (B0) score: registration status + name length + all relationship
    types counted as children (capped at 60)."""
    E = ents()
    RS = E['RS']
    rs, es = E['rs'], E['es']
    s = np.where(rs == RS.index('ISSUED'), 15.0, np.where(rs == RS.index('LAPSED'), 4.0, 0.0))
    bad = (es != 1) | np.isin(rs, [RS.index('RETIRED'), RS.index('ANNULLED'), RS.index('DUPLICATE')])
    s = s - 45.0 * bad
    s = s + np.maximum(0.0, 14.0 - E['name_len'] / 6.0)
    kids = E['rel'].sum(axis=1)
    s = s + np.minimum(kids, 60) * 1.2
    return s


# ----------------------------------------------------------------------------------
# Index
# ----------------------------------------------------------------------------------
class Index:
    """tokset: 'v3' (ranking.py tokenizer) or 'v2' (baseline, B0). types: name-variant
    types that are indexed and matched (0 legal, 1 trading, 2 alt-language,
    3 transliterated, 4 previous legal name)."""

    def __init__(self, tokset='v3', types=(0,), words_per_file=WORDS_PER_FILE,
                 file_postings=None, split=SPLIT, strip=True):
        self.tokset, self.types = tokset, tuple(sorted(types))
        self.words_per_file, self.file_postings, self.split = words_per_file, file_postings, split
        tag = f'{tokset}_{"".join(map(str, self.types))}_{words_per_file}_{file_postings}_{split}'
        path = CACHE + f'index_{tag}.pkl'
        suffix = '' if tokset == 'v3' else '_v2'
        rows = np.load(CACHE + f'rows{suffix}.npz')
        self.row_ent, self.row_type = rows['row_ent'], rows['row_type']
        self.tptr, self.tok, self.xptr, self.ext = rows['tptr'], rows['tok'], rows['xptr'], rows['ext']
        self.cs, self.ce = rows['cs'].astype(np.int64), rows['ce'].astype(np.int64)
        if not strip:                     # no legal-form stripping: core = full name
            self.cs[:] = 0
            self.ce = np.diff(rows['tptr']).astype(np.int64)
        self.vocab = pickle.load(open(CACHE + f'vocab{suffix}.pkl', 'rb'))
        N = len(ents()['lei'])
        self.N = N
        self.row_on = np.isin(self.row_type, self.types)
        # entity -> rows (rows are grouped by entity, ascending)
        self.eptr = np.searchsorted(self.row_ent, np.arange(N + 1))
        if os.path.exists(path):
            d = pickle.load(open(path, 'rb'))
            self.__dict__.update(d)
            return
        t0 = time.time()
        vlen = np.fromiter((len(w) for w in self.vocab), dtype=np.int32, count=len(self.vocab))
        on_rows = np.where(self.row_on)[0]
        terms, entl = [], []
        for ptr, arr in ((self.tptr, self.tok), (self.xptr, self.ext)):
            a, b = ptr[on_rows], ptr[on_rows + 1]
            L = b - a
            idx = np.repeat(a - np.concatenate([[0], np.cumsum(L)[:-1]]), L) + np.arange(L.sum())
            t = arr[idx]
            e = np.repeat(self.row_ent[on_rows], L)
            keep = vlen[t] >= 2
            terms.append(t[keep])
            entl.append(e[keep])
        key = np.unique(np.concatenate(terms).astype(np.int64) * N + np.concatenate(entl))
        post_term = (key // N).astype(np.int32)
        post_ent = (key % N).astype(np.int32)
        del key
        words, starts = np.unique(post_term, return_index=True)
        cnt = np.diff(np.append(starts, len(post_term)))
        # --- v2 shard planning over the sorted indexed words -------------------------
        wstr = [self.vocab[i] for i in words]
        csum = np.concatenate([[0], np.cumsum(cnt)])
        shards = []                       # (key, a, b) word-index ranges in sorted order

        def plan(prefix, a, b):
            if csum[b] - csum[a] <= split or len(prefix) >= MAXDEPTH:
                shards.append((prefix, a, b))
                return
            L = len(prefix)
            i = a
            if len(wstr[i]) <= L:          # the word equal to the prefix stays here
                shards.append((prefix, i, i + 1))
                i += 1
            while i < b:
                c = wstr[i][L]
                j = i
                while j < b and wstr[j][L] == c:
                    j += 1
                plan(prefix + c, i, j)
                i = j

        i, n = 0, len(wstr)
        while i < n:
            p = wstr[i][:2]
            j = i
            while j < n and wstr[j][:2] == p:
                j += 1
            plan(p, i, j)
            i = j
        # --- pack shards into files ----------------------------------------------------
        files, cur_a, cur_words, cur_post = [], None, 0, 0
        if file_postings is None:
            # v2: close a file after the shard that takes it past WORDS_PER_FILE words
            for k, a, b in shards:
                if cur_a is None:
                    cur_a = a
                cur_words += b - a
                if cur_words > words_per_file:
                    files.append((cur_a, b))
                    cur_a, cur_words = None, 0
        else:
            # per-shard cap: close a file before a shard would take it past
            # file_postings postings (only single oversized shards are then capped)
            for k, a, b in shards:
                sp = csum[b] - csum[a]
                if cur_a is not None and cur_post + sp > file_postings:
                    files.append((cur_a, a))
                    cur_a, cur_post = None, 0
                if cur_a is None:
                    cur_a = a
                cur_post += sp
        if cur_a is not None:
            files.append((cur_a, len(wstr)))
        # file -> unique entity ids (uncapped)
        fptr, fents = [0], []
        for a, b in files:
            e = np.unique(post_ent[csum[a]:csum[b]])
            fents.append(e)
            fptr.append(fptr[-1] + len(e))
        d = dict(
            bounds=[wstr[a] for a, _ in files],
            file_word_ranges=np.array(files, dtype=np.int64),
            n_shards=len(shards), n_words=len(wstr), n_postings=int(len(post_ent)),
            fptr=np.array(fptr, dtype=np.int64), fents=np.concatenate(fents).astype(np.int32),
            words=words.astype(np.int32), word_cnt=cnt.astype(np.int32),
        )
        pickle.dump(d, open(path, 'wb'), protocol=4)
        self.__dict__.update(d)
        print(f'  index {tag}: {len(files)} files, {len(shards)} shards, {len(wstr):,} words, '
              f'{len(post_ent):,} postings, {time.time() - t0:.0f}s', flush=True)

    @property
    def n_files(self):
        return len(self.bounds)

    @property
    def capped(self):
        """Routing-table bit per file: more entities than the cap (single oversized word)."""
        if not hasattr(self, '_capped'):
            self._capped = (np.diff(self.fptr) > CAP).tolist()
        return self._capped

    # ---------------------------------------------------------------- per-file cap
    def cap(self, P, cap=CAP):
        """Return kept-entity CSR (kptr, kents) for prominence array P."""
        kptr, kents = [0], []
        for f in range(self.n_files):
            e = self.fents[self.fptr[f]:self.fptr[f + 1]]
            if len(e) > cap:
                # highest P first, ties -> lower entity id
                pe = P[e]
                part = np.argpartition(-pe, cap - 1)
                thr = pe[part[cap - 1]]
                sure = e[pe > thr]
                tie = np.sort(e[pe == thr])[:cap - len(sure)]
                e = np.sort(np.concatenate([sure, tie]))
            kents.append(e)
            kptr.append(kptr[-1] + len(e))
        return np.array(kptr, dtype=np.int64), np.concatenate(kents).astype(np.int32)

    # ---------------------------------------------------------------- routing
    def route(self, Q, mode, last_is_prefix=True, f_max=R.F_MAX, params=None, paused=True):
        if mode == 'budget':
            return R.route_budget(Q, self.bounds, self.capped, last_is_prefix, paused,
                                  params or R.ROUTE)
        return R.route(Q, self.bounds, mode, last_is_prefix, f_max)

    # ---------------------------------------------------------------- token matching
    def _tok_info(self, q):
        c = self.__dict__.setdefault('_tokcache', {})
        if q in c:
            return c[q]
        V = self.vocab
        lo = bisect.bisect_left(V, q)
        hi = bisect.bisect_left(V, q + '{')
        exact = lo if lo < len(V) and V[lo] == q else -1
        fz = None
        if len(q) >= R.FUZZY_MIN_LEN:
            alpha = 'abcdefghijklmnopqrstuvwxyz0123456789'
            var = set()
            for i in range(len(q)):
                var.add(q[:i] + q[i + 1:])
                for ch in alpha:
                    var.add(q[:i] + ch + q[i + 1:])
                if i + 1 < len(q):
                    var.add(q[:i] + q[i + 1] + q[i] + q[i + 2:])
            for i in range(len(q) + 1):
                for ch in alpha:
                    var.add(q[:i] + ch + q[i:])
            var.discard(q)
            rng = []
            for v in var:
                a = bisect.bisect_left(V, v)
                b = bisect.bisect_left(V, v + '{')
                if b > a:
                    rng.append((a, b))
            rng.sort()
            merged = []
            for a, b in rng:
                if merged and a <= merged[-1][1]:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            if merged:
                m = np.array(merged, dtype=np.int64)
                fz = (m[:, 0], m[:, 1])
        c[q] = (exact, lo, hi, fz)
        return c[q]

    def _levels(self, toks, info):
        exact, lo, hi, fz = info
        lv = np.zeros(len(toks), dtype=np.int8)
        if fz is not None:
            s, e = fz
            j = np.searchsorted(s, toks, side='right') - 1
            ok = (j >= 0) & (toks < e[np.maximum(j, 0)])
            lv[ok] = 1
        lv[(toks >= lo) & (toks < hi)] = 2
        if exact >= 0:
            lv[toks == exact] = 3
        return lv

    def features(self, Q, ent_ids):
        """Row-level match features for candidate entities. Returns dict of arrays over
        candidate rows (only rows with >= 1 matched token) incl. 'ent'."""
        n = len(Q)
        e = np.asarray(ent_ids, dtype=np.int64)
        a, b = self.eptr[e], self.eptr[e + 1]
        L = b - a
        rows = np.repeat(a - np.concatenate([[0], np.cumsum(L)[:-1]]), L) + np.arange(L.sum())
        rows = rows[self.row_on[rows]]
        nr = len(rows)
        infos = [self._tok_info(q) for q in Q]
        # gather seq tokens
        ta, tb = self.tptr[rows], self.tptr[rows + 1]
        TL = tb - ta
        tidx = np.repeat(ta - np.concatenate([[0], np.cumsum(TL)[:-1]]), TL) + np.arange(TL.sum())
        toks = self.tok[tidx]
        trow = np.repeat(np.arange(nr), TL)
        tpos = tidx - np.repeat(ta, TL)
        xa, xb = self.xptr[rows], self.xptr[rows + 1]
        XL = xb - xa
        xidx = np.repeat(xa - np.concatenate([[0], np.cumsum(XL)[:-1]]), XL) + np.arange(XL.sum())
        xt = self.ext[xidx]
        xrow = np.repeat(np.arange(nr), XL)
        lev = np.zeros((nr, n), dtype=np.int64)
        pos = np.full((nr, n), -1, dtype=np.int64)
        for i, info in enumerate(infos):
            lv = self._levels(toks, info).astype(np.int64)
            key = np.zeros(nr, dtype=np.int64)
            np.maximum.at(key, trow, lv * 1000 + (999 - tpos))
            ls = key // 1000
            ps = np.where(ls > 0, 999 - key % 1000, -1)
            lx = np.zeros(nr, dtype=np.int64)
            if len(xt):
                np.maximum.at(lx, xrow, self._levels(xt, info).astype(np.int64))
            lev[:, i] = np.maximum(ls, lx)
            pos[:, i] = np.where(ls >= lx, ps, -1)
        stop = np.array([q in R.QUERY_STOP for q in Q])
        content = ~stop if (~stop).any() else np.ones(n, bool)
        nmiss = ((lev == 0) & content[None, :]).sum(1)
        keep = ((lev > 0) & content[None, :]).any(1)
        rows, lev, pos, nmiss = rows[keep], lev[keep], pos[keep], nmiss[keep]
        ta, TL = ta[keep], TL[keep]
        cs, ce = self.cs[rows], self.ce[rows]
        ncore = ce - cs

        def seq_prefix(start):
            ok = (start + n) <= TL
            for i in range(n):
                p = np.minimum(ta + start + i, len(self.tok) - 1)
                t = self.tok[p]
                exact, lo, hi, _ = infos[i]
                if i < n - 1:
                    ok &= (t == exact) if exact >= 0 else False
                else:
                    ok &= (t >= lo) & (t < hi)
            return ok

        core_prefix = seq_prefix(cs) & (n <= ncore)
        name_prefix = seq_prefix(np.zeros(len(rows), dtype=np.int64))
        last = infos[n - 1][0]
        tail_ok = self.tok[np.minimum(ta + np.maximum(cs + n - 1, 0), len(self.tok) - 1)] == last
        full_ok = self.tok[np.minimum(ta + n - 1, len(self.tok) - 1)] == last
        core_exact = (core_prefix & (n == ncore) & tail_ok) | (name_prefix & (n == TL) & full_ok)
        # coverage: distinct matched positions inside the core
        pc = np.where((pos >= cs[:, None]) & (pos < ce[:, None]), pos, -1)
        pc.sort(axis=1)
        distinct = (pc >= 0) & np.concatenate([np.ones((len(rows), 1), bool),
                                                pc[:, 1:] != pc[:, :-1]], axis=1)
        coverage = distinct.sum(1) / np.maximum(1, ncore)
        in_order = np.ones(len(rows), bool)
        last = np.full(len(rows), -1)
        for i in range(n):
            p = pos[:, i]
            in_order &= (p < 0) | (p > last)
            last = np.where(p >= 0, p, last)
        return {
            'ent': self.row_ent[rows].astype(np.int64),
            'alt': (self.row_type[rows] != 0),
            'n': n,
            'n_miss': nmiss, 'n_fuzzy': (lev == 1).sum(1), 'n_exact': (lev == 3).sum(1),
            'core_exact': core_exact, 'seq_prefix': core_prefix | name_prefix,
            'coverage': coverage, 'in_order': in_order,
        }


def match_scores(F, W):
    n = F['n']
    s = (W['m_all'] * (F['n_miss'] == 0) - W['m_miss'] * F['n_miss'] - W['m_fuzzy'] * F['n_fuzzy']
         + W['m_exact'] * F['n_exact'] / n + W['m_core_exact'] * F['core_exact']
         + W['m_prefix'] * F['seq_prefix'] + W['m_coverage'] * F['coverage']
         + W.get('m_order', 0.0) * F['in_order'] - W.get('m_alt', 0.0) * F['alt'])
    return s


def rank_entities(F, P, W, k=10, b0=False):
    """Top-k entity ids. b0=True: baseline behaviour (all tokens prefix-match, order by P)."""
    if len(F['ent']) == 0:
        return np.zeros(0, dtype=np.int64)
    ent = F['ent']
    if b0:
        ok = (F['n_miss'] == 0) & (F['n_fuzzy'] == 0)
        ent = ent[ok]
        s = np.zeros(len(ent))
        if len(ent) == 0:
            return np.zeros(0, dtype=np.int64)
    else:
        s = match_scores(F, W)
    # entity score = max over its rows
    order = np.lexsort((-s, ent))
    ent_s, s_s = ent[order], s[order]
    first = np.concatenate([[True], ent_s[1:] != ent_s[:-1]])
    ue, us = ent_s[first], s_s[first] + P[ent_s[first]]
    top = np.lexsort((ue, -us))[:k]
    return ue[top]


# ----------------------------------------------------------------------------------
# Query execution
# ----------------------------------------------------------------------------------
def candidates(idx, kept, files):
    kptr, kents = kept
    if not files:
        return np.zeros(0, dtype=np.int64)
    parts = [kents[kptr[f]:kptr[f + 1]] for f in files]
    return np.unique(np.concatenate(parts)).astype(np.int64)


def run_query(idx, kept, P, W, query, mode, last_is_prefix=True, f_max=R.F_MAX, b0=False,
              qtok=None):
    Q = qtok(query) if qtok else R.query_tokens(query)
    if b0:
        Q = [q for q in Q if len(q) >= 2]
    if not Q:
        return Q, [], np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    files = idx.route(Q, 'first' if b0 else mode, last_is_prefix, f_max)
    C = candidates(idx, kept, files)
    F = idx.features(Q, C)
    return Q, files, C, rank_entities(F, P, W, b0=b0)
