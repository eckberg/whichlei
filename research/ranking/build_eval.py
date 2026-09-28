"""
Build the evaluation set (see eval/METHOD.md). Deterministic: every random choice uses
random.Random seeded from SEED below. Uses only raw data + the shared tokenizer; it does
NOT use any prominence signal or scorer weight.

Outputs eval/{head,torso,tail,typo}.tsv (this repo's committed copies are the source of
truth; see run_all.sh) with columns
  query  target_lei  stratum  split  qtype  alt_leis  entity_name  qid  sitelinks

Not run by default: run_all.sh uses the committed eval/*.tsv. Rebuilding calls Wikidata's
live query service, so it is not exactly reproducible run to run (see README).
"""
import collections
import hashlib
import pickle
import random
import re
import sys

import numpy as np

from paths import CACHE, EVAL, SIG


class R:
    """Frozen copy of the tokenizer used when this eval set was built (2026-09-27). The eval
    must not change when ranking.py's tokenizer is tuned, so it does not import it."""
    FOLD = str.maketrans({
        'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'ł': 'l', 'Ł': 'l',
        'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'œ': 'oe', 'Œ': 'oe',
        'ı': 'i', 'ŋ': 'n', 'ħ': 'h', 'ŧ': 't'})
    ALNUM = re.compile(r'[a-z0-9]+')

    @staticmethod
    def fold(s):
        import unicodedata
        s = unicodedata.normalize('NFKD', s.translate(R.FOLD))
        return ''.join(c for c in s if not unicodedata.combining(c)).lower()

    @staticmethod
    def _merge(runs):
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

    @staticmethod
    def name_tokens(name):
        runs_all, extras = [], []
        for chunk in R.fold(name).split():
            runs = R.ALNUM.findall(chunk)
            if not runs:
                continue
            runs_all.extend(runs)
            if len(runs) >= 2:
                extras.append(''.join(runs))
        seq = R._merge(runs_all)
        seen = set(seq)
        return seq, [x for x in dict.fromkeys(extras) if x not in seen]

    @staticmethod
    def query_tokens(q):
        toks = []
        for chunk in R.fold(q).split():
            runs = R.ALNUM.findall(chunk)
            if not runs:
                continue
            if len(runs) >= 2 and all(len(r) <= 2 for r in runs):
                toks.append(''.join(runs))
            else:
                toks.extend(runs)
        return R._merge(toks)

SEED = 20260927
OUT = sys.argv[1] if len(sys.argv) > 1 else EVAL
N_HEAD, N_TORSO, N_TAIL = 600, 500, 500
MAX_ALIASES = 3

S = pickle.load(open(CACHE + 'ents_str.pkl', 'rb'))
E = np.load(CACHE + 'ents.npz')
LEI, NAME = S['lei'], S['name']
lei2id = {l: i for i, l in enumerate(LEI)}
N = len(LEI)
es, rs, rel, isin, bic = E['es'], E['rs'], E['rel'], E['isin'], E['bic']
RS = S['RS']


def split_of(key):
    return hashlib.sha1(f'{SEED}:{key}'.encode()).hexdigest()


def assign_split(keys):
    """Exact 50/50 split: sort entities by a seeded hash, first half = train."""
    order = sorted(keys, key=split_of)
    half = len(order) // 2
    return {k: ('train' if i < half else 'test') for i, k in enumerate(order)}


CODE_PATTERNS = [
    re.compile(r'^[A-Z]{2}-[A-Z0-9]{1,3}$'),              # ISO 3166-2, e.g. US-TX
    re.compile(r'^[A-Z0-9]{18}[0-9]{2}$'),                # LEI
    re.compile(r'^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),            # ISIN
    re.compile(r'^Q[0-9]+$'),                             # Wikidata id
    re.compile(r'^(NYSE|NASDAQ|LSE|TYO|TSE|FWB|SIX|OMX|HKEX|SSE|SZSE|ASX|TSX|BME|BIT|'
               r'Euronext)\s*:', re.I),                   # tickers
    re.compile(r'^[A-Z][a-z]{1,4}\.$'),                   # 'Fla.', 'Mich.'
]


def is_code(s):
    s = s.strip()
    if not re.search(r'[A-Za-z]', s):
        return True
    if any(p.search(s) for p in CODE_PATTERNS):
        return True
    digits = sum(c.isdigit() for c in s)
    return digits >= 4 and digits * 2 >= len(s.replace(' ', ''))


# --- name vocabulary of an entity (all GLEIF name variants) for answerability ----------
OTHER = {}


def load_other_names(wanted):
    with open(SIG + 'entities.tsv', encoding='utf-8') as f:
        h = f.readline().rstrip('\n').split('\t')
        H = {k: i for i, k in enumerate(h)}
        for line in f:
            lei = line[:20]
            if lei in wanted:
                p = line.rstrip('\n').split('\t')
                names = [p[1]]
                if p[H['other_names']]:
                    names += p[H['other_names']].split(' | ')
                if p[H['transliterated_names']]:
                    names += p[H['transliterated_names']].split(' | ')
                OTHER[lei] = names


def answerable(query, leis):
    """Every query token prefix-matches a token of some GLEIF name of the target."""
    Q = R.query_tokens(query)
    if not Q:
        return False
    toks = set()
    for l in leis:
        for nm in OTHER.get(l, [NAME[lei2id[l]]]):
            seq, ext = R.name_tokens(nm)
            toks.update(seq)
            toks.update(ext)
    return all(any(t.startswith(q) for t in toks) for q in Q)


def build_head():
    items = collections.defaultdict(lambda: {'leis': set(), 'sl': 0, 'label': '', 'aliases': ''})
    best_q_for_lei = {}
    rows = []
    with open(SIG + 'wikidata.tsv', encoding='utf-8') as f:
        f.readline()
        for line in f:
            qid, lei, label, aliases, sl, inst = line.rstrip('\n').split('\t')
            i = lei2id.get(lei)
            if i is None or es[i] != 1:
                continue
            sl = int(sl) if sl.isdigit() else 0
            rows.append((qid, lei, label, aliases, sl))
            b = best_q_for_lei.get(lei)
            if b is None or (sl, -int(qid[1:])) > b[0]:
                best_q_for_lei[lei] = ((sl, -int(qid[1:])), qid)
    for qid, lei, label, aliases, sl in rows:
        if best_q_for_lei[lei][1] != qid:
            continue                   # this LEI belongs to a more prominent item
        it = items[qid]
        it['leis'].add(lei)
        it['sl'] = sl
        it['label'] = label
        it['aliases'] = aliases
    ranked = sorted(items.items(), key=lambda kv: (-kv[1]['sl'], int(kv[0][1:])))
    chosen, dropped_code = [], 0
    for qid, it in ranked:
        if not it['label'] or is_code(it['label']):
            dropped_code += 1
            continue
        chosen.append((qid, it))
        if len(chosen) == N_HEAD:
            break
    all_leis = set(l for _, it in chosen for l in it['leis'])
    load_other_names(all_leis)
    split = assign_split([min(it['leis']) for _, it in chosen])
    rng = random.Random(SEED + 1)
    out, stats = [], collections.Counter()
    for qid, it in chosen:
        leis = sorted(it['leis'])
        # primary target: the LEI whose legal name best matches the label (ties -> first)
        lab_toks = set(R.query_tokens(it['label']))
        leis.sort(key=lambda l: (-len(lab_toks & set(R.name_tokens(NAME[lei2id[l]])[0])), l))
        tgt, alts = leis[0], leis[1:]
        sp = split[min(it['leis'])]
        base = dict(target=tgt, alts='|'.join(alts), split=sp, name=NAME[lei2id[tgt]],
                    qid=qid, sl=it['sl'])
        out.append(dict(base, query=it['label'], stratum='head', qtype='label'))
        stats['label'] += 1
        stats['label_answerable'] += answerable(it['label'], leis)
        seen = {' '.join(R.query_tokens(it['label']))}
        cands = []
        for a in [x.strip() for x in it['aliases'].split(' | ') if x.strip()]:
            key = ' '.join(R.query_tokens(a))
            if key in seen:
                continue
            seen.add(key)
            stats['alias_raw'] += 1
            if is_code(a) or len(key.replace(' ', '')) <= 2 or len(a) > 60:
                stats['alias_code_or_short'] += 1
                continue
            if not answerable(a, leis):
                stats['alias_unanswerable'] += 1
                continue
            cands.append(a)
        if len(cands) > MAX_ALIASES:
            stats['alias_capped'] += len(cands) - MAX_ALIASES
            cands = rng.sample(cands, MAX_ALIASES)
        for a in cands:
            out.append(dict(base, query=a, stratum='head', qtype='alias'))
            stats['alias'] += 1
    stats['items_dropped_code_label'] = dropped_code
    stats['min_sitelinks'] = chosen[-1][1]['sl']
    return out, stats


# --- non-distinctive words for torso queries: legal forms + stopwords -----------------
STOP = {'the', 'and', 'of', 'de', 'du', 'des', 'la', 'le', 'les', 'der', 'die', 'das',
        'und', 'y', 'e', 'et', 'di', 'del', 'della', 'van', 'von', 'for', 'en', 'i', 'a',
        'limited', 'company', 'corporation', 'incorporated', 'private', 'public',
        'sociedad', 'anonima', 'societa', 'spolka', 'ograniczona', 'odpowiedzialnoscia',
        'responsabilita', 'limitata', 'limitada', 'gesellschaft', 'beschrankter',
        'haftung', 'mbh', 'haftungsbeschrankt', 'korlatolt', 'felelossegu', 'tarsasag',
        'sirketi', 'akcyjna', 'komandytowa', 'jawna', 'responsabilidad', 'societe',
        'responsabilite', 'limitee', 'anonyme', 'simplifiee', 'par', 'actions'}


def nondistinct_words():
    words = set(STOP)
    with open(SIG + 'elf.tsv', encoding='utf-8') as f:
        f.readline()
        for line in f:
            p = line.rstrip('\n').split('\t')
            for ab in p[4].split(' | '):                 # every abbreviation token
                seq, ext = R.name_tokens(ab)
                words.update(seq)
                words.update(ext)
            for ln in p[3].split(' | '):                 # single-word local names
                seq, _ = R.name_tokens(ln)
                if len(seq) == 1:
                    words.add(seq[0])
    return words


def build_torso(wd_leis):
    ND = nondistinct_words()
    has_kids = rel.sum(axis=1) > 0
    pool = np.where((es == 1) & (has_kids | (isin > 0) | (bic > 0)))[0]
    pool = [i for i in pool if LEI[i] not in wd_leis]
    rng = random.Random(SEED + 2)
    rng.shuffle(pool)
    out, stats = [], collections.Counter()
    stats['pool'] = len(pool)
    for i in pool:
        seq, _ = R.name_tokens(NAME[i])
        dist = [t for t in seq if len(t) >= 2 and t not in ND and not t.isdigit()]
        if not dist:
            stats['skipped_no_distinctive_word'] += 1
            continue
        k = rng.choice([1, 2]) if len(dist) >= 2 else 1
        stats[f'k{k}'] += 1
        stats['with_children'] += bool(has_kids[i])
        stats['with_isin'] += bool(isin[i] > 0)
        stats['with_bic'] += bool(bic[i] > 0)
        stats['reg_' + RS[rs[i]]] += 1
        out.append(dict(query=' '.join(dist[:k]), target=LEI[i], alts='', name=NAME[i],
                        qid='', sl=0, stratum='torso', qtype=f'words{k}'))
        if len(out) == N_TORSO:
            break
    split = assign_split([o['target'] for o in out])
    for o in out:
        o['split'] = split[o['target']]
    return out, stats


def build_tail(wd_leis):
    counts = collections.Counter()
    norm = [None] * N
    for i in range(N):
        seq, _ = R.name_tokens(NAME[i])
        k = ' '.join(seq)
        norm[i] = k
        counts[k] += 1
    pool = [i for i in range(N) if rs[i] == 0 and norm[i] and counts[norm[i]] == 1
            and LEI[i] not in wd_leis]
    rng = random.Random(SEED + 3)
    pick = sorted(rng.sample(pool, N_TAIL))
    split = assign_split([LEI[i] for i in pick])
    out = [dict(query=NAME[i], target=LEI[i], alts='', name=NAME[i], qid='', sl=0,
                stratum='tail', qtype='fullname', split=split[LEI[i]]) for i in pick]
    empty = sum(1 for k in norm if not k)
    return out, {'pool': len(pool), 'names_without_latin_tokens': empty,
                 'unique_norm_names': sum(1 for c in counts.values() if c == 1)}


def make_typo(s, rng, early):
    s = R.fold(s)
    idx = [i for i, c in enumerate(s) if c.isalnum()]
    if len(idx) < 5:
        return None
    cand = [i for i in idx if (i < 3) == early]
    if early:
        cand = [i for i in idx[:3]]
    else:
        cand = [i for i in idx[3:]]
    for _ in range(20):
        i = rng.choice(cand)
        op = rng.choice(['delete', 'substitute', 'transpose'])
        if op == 'delete':
            return s[:i] + s[i + 1:], op, i
        if op == 'substitute':
            c = rng.choice([x for x in 'abcdefghijklmnopqrstuvwxyz' if x != s[i]])
            return s[:i] + c + s[i + 1:], op, i
        if i + 1 < len(s) and s[i + 1].isalnum() and s[i + 1] != s[i]:
            return s[:i] + s[i + 1] + s[i] + s[i + 2:], op, i
    return None


def build_typo(head):
    rng = random.Random(SEED + 4)
    out = []
    for h in head:
        if h['qtype'] != 'label':
            continue
        for early in (True, False):
            r = make_typo(h['query'], rng, early)
            if r is None:
                continue
            q, op, pos = r
            out.append(dict(h, query=q, stratum='typo',
                            qtype=('typo_first3' if early else 'typo_later') + ':' + op))
    return out


def write(rows, path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('query\ttarget_lei\tstratum\tsplit\tqtype\talt_leis\tentity_name\tqid\tsitelinks\n')
        for r in rows:
            f.write('\t'.join(str(x).replace('\t', ' ') for x in (
                r['query'], r['target'], r['stratum'], r['split'], r['qtype'], r['alts'],
                r['name'], r['qid'], r['sl'])) + '\n')


def main():
    wd_leis = set()
    with open(SIG + 'wikidata.tsv', encoding='utf-8') as f:
        f.readline()
        for line in f:
            wd_leis.add(line.split('\t')[1])
    head, hs = build_head()
    print('head', dict(hs))
    torso, ts = build_torso(wd_leis)
    print('torso', dict(ts))
    tail, ls = build_tail(wd_leis)
    print('tail', ls)
    typo = build_typo(head)
    print('typo', collections.Counter(t['qtype'].split(':')[0] for t in typo))
    for name, rows in (('head', head), ('torso', torso), ('tail', tail), ('typo', typo)):
        write(rows, OUT + name + '.tsv')
        c = collections.Counter(r['split'] for r in rows)
        print(name, len(rows), dict(c))
    pickle.dump({'head': dict(hs), 'torso': dict(ts), 'tail': ls}, open(OUT + 'build_stats.pkl', 'wb'))


if __name__ == '__main__':
    main()
