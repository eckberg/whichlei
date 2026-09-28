"""
One-off preparation: parse entities.tsv + signal files once, tokenise every name variant,
and cache compact numpy arrays under cache/ (see paths.py).

Outputs
  ents.npz      numeric per-entity attributes (index = row order of entities.tsv)
  ents_str.pkl  lei, legal name, country, lei->id
  rows.npz      one row per name variant: entity id, variant type, token CSR (ids into
                vocab), extras CSR, core range
  vocab.pkl     sorted vocabulary (token ids follow sort order => prefix = id range)
  pairs.npz     ACTIVE direct/ultimate consolidation pairs (child, parent)
"""
import collections
import csv
import io
import os
import pickle
import time
import zipfile

import numpy as np

import ranking as R
from paths import CACHE, RR_ZIP, SIG

OUT = CACHE
T0 = time.time()


def lap(m):
    print(f'[{time.time() - T0:7.1f}s] {m}', flush=True)


ES = {'ACTIVE': 1, 'INACTIVE': 0, 'NULL': -1}
RS = ['ISSUED', 'LAPSED', 'PENDING_TRANSFER', 'PENDING_ARCHIVAL', 'RETIRED', 'DUPLICATE',
      'ANNULLED', 'MERGED']
CAT = ['GENERAL', 'FUND', 'SOLE_PROPRIETOR', 'RESIDENT_GOVERNMENT_ENTITY', 'BRANCH',
       'INTERNATIONAL_ORGANIZATION', '']
CORR = {'FULLY_CORROBORATED': 2, 'PARTIALLY_CORROBORATED': 1, 'ENTITY_SUPPLIED_ONLY': 0, '': -1}
VT = {'LEGAL': 0, 'TRADING_OR_OPERATING_NAME': 1, 'ALTERNATIVE_LANGUAGE_LEGAL_NAME': 2,
      'TRANSLITERATED': 3, 'PREVIOUS_LEGAL_NAME': 4}


def year(s):
    if len(s) >= 10 and s[:4].isdigit():
        return int(s[:4]) + (int(s[5:7]) - 1) / 12.0
    return np.nan


def main():
    lf = R.load_legal_form_phrases(SIG + 'elf.tsv')
    lap(f'{len(lf)} legal-form phrases')

    leis, names, ctry, lfc = [], [], [], []
    es, rs, cat, corr, regy, crey = [], [], [], [], [], []
    # name-variant rows
    row_ent, row_type = [], []
    row_seq, row_ext = [], []
    vocab = {}

    def tok_ids(ts):
        out = []
        for t in ts:
            i = vocab.get(t)
            if i is None:
                i = len(vocab)
                vocab[t] = i
            out.append(i)
        return out

    sfx = collections.Counter()
    with open(SIG + 'entities.tsv', encoding='utf-8') as f:
        hdr = f.readline().rstrip('\n').split('\t')
        H = {k: i for i, k in enumerate(hdr)}
        for eid, line in enumerate(f):
            p = line.rstrip('\n').split('\t')
            leis.append(p[0])
            names.append(p[1])
            ctry.append(p[H['country']])
            lfc.append(p[H['legal_form_code']])
            es.append(ES.get(p[H['entity_status']], -1))
            r = p[H['registration_status']]
            rs.append(RS.index(r) if r in RS else 7)
            c = p[H['entity_category']]
            cat.append(CAT.index(c) if c in CAT else 6)
            corr.append(CORR.get(p[H['corroboration_level']], -1))
            regy.append(year(p[H['initial_registration_date']]))
            crey.append(year(p[H['entity_creation_date']]))
            variants = [(0, p[1])]
            on, ot = p[H['other_names']], p[H['other_name_types']]
            if on:
                for nm, ty in zip(on.split(' | '), ot.split(' | ')):
                    variants.append((VT.get(ty, 4), nm))
            tn = p[H['transliterated_names']]
            if tn:
                for nm in tn.split(' | '):
                    variants.append((3, nm))
            # dedupe identical token sequences keeping the most useful type:
            # legal < trading < alt-language < transliterated < previous
            variants = [variants[0]] + sorted(variants[1:], key=lambda x: x[0])
            seen = set()
            for vt, nm in variants:
                seq, ext = R.name_tokens(nm)
                key = tuple(seq)
                if (not seq) or key in seen:
                    if vt == 0:          # keep an (empty) legal row so every entity has one
                        pass
                    else:
                        continue
                seen.add(key)
                if vt == 0 and seq:
                    for L in range(1, min(6, len(seq) - 1) + 1):
                        ph = tuple(seq[-L:])
                        if ph in lf:
                            sfx[ph] += 1
                row_ent.append(eid)
                row_type.append(vt)
                row_seq.append(tok_ids(seq))
                row_ext.append(tok_ids(ext))
            if eid % 500000 == 0:
                lap(f'{eid:,} entities')
    N = len(leis)
    lap(f'{N:,} entities, {len(row_ent):,} name rows, {len(vocab):,} vocab')

    # legal-form phrases actually used as name suffixes (>= 20 times) -> core ranges
    lf_used = set(ph for ph, c in sfx.items() if c >= 20) | set(R.LF_EXTRA)
    lap(f'{len(lf_used)} legal-form phrases used as suffix >= 20 times')
    inv = [None] * len(vocab)
    for w, i in vocab.items():
        inv[i] = w
    cs_l, ce_l = [], []
    for ids in row_seq:
        seq = [inv[i] for i in ids]
        a, b = R.core_range(seq, lf_used) if seq else (0, 0)
        cs_l.append(a)
        ce_l.append(b)
    lap('core ranges computed')

    # sort vocab so that ids follow lexicographic order
    words = sorted(vocab)
    remap = np.empty(len(vocab), dtype=np.int32)
    for new, w in enumerate(words):
        remap[vocab[w]] = new

    def csr(lists):
        ptr = np.zeros(len(lists) + 1, dtype=np.int64)
        ptr[1:] = np.cumsum([len(x) for x in lists])
        flat = np.fromiter((i for x in lists for i in x), dtype=np.int32, count=int(ptr[-1]))
        return ptr, remap[flat] if len(flat) else flat

    tptr, tok = csr(row_seq)
    xptr, ext = csr(row_ext)
    np.savez(OUT + 'rows.npz', row_ent=np.array(row_ent, dtype=np.int32),
             row_type=np.array(row_type, dtype=np.int8), tptr=tptr, tok=tok, xptr=xptr,
             ext=ext, cs=np.array(cs_l, dtype=np.int16), ce=np.array(ce_l, dtype=np.int16))
    with open(OUT + 'vocab.pkl', 'wb') as fo:
        pickle.dump(words, fo, protocol=4)
    lap('rows + vocab saved')

    lei2id = {l: i for i, l in enumerate(leis)}

    # relationships (children counts per type)
    rel = np.zeros((N, 6), dtype=np.int32)
    with open(SIG + 'relationships.tsv') as f:
        h = f.readline().rstrip('\n').split('\t')
        rel_types = h[1:]
        for line in f:
            p = line.rstrip('\n').split('\t')
            i = lei2id.get(p[0])
            if i is not None:
                rel[i] = [int(x) for x in p[1:]]
    hasp = np.zeros((N, 2), dtype=np.int8)
    with open(SIG + 'has_parent.tsv') as f:
        f.readline()
        for line in f:
            p = line.rstrip('\n').split('\t')
            i = lei2id.get(p[0])
            if i is not None:
                hasp[i] = [int(p[1]), int(p[2])]
    isin = np.zeros(N, dtype=np.int32)
    with open(SIG + 'isin_count.tsv') as f:
        f.readline()
        for line in f:
            a, b = line.rstrip('\n').split('\t')
            i = lei2id.get(a)
            if i is not None:
                isin[i] = int(b)
    bic = np.zeros(N, dtype=np.int8)
    with open(SIG + 'bic.tsv') as f:
        f.readline()
        for line in f:
            i = lei2id.get(line.split('\t')[0])
            if i is not None:
                bic[i] = 1
    mic = np.zeros(N, dtype=np.int8)
    with open(SIG + 'mic.tsv') as f:
        f.readline()
        for line in f:
            i = lei2id.get(line.split('\t')[0])
            if i is not None:
                mic[i] = 1
    sitelinks = np.zeros(N, dtype=np.int32)
    with open(SIG + 'wikidata.tsv', encoding='utf-8') as f:
        f.readline()
        for line in f:
            p = line.rstrip('\n').split('\t')
            i = lei2id.get(p[1])
            if i is not None and p[4].isdigit():
                sitelinks[i] = max(sitelinks[i], int(p[4]))
    lap('signals loaded')

    # parent/child pairs from the relationship golden copy
    ch, pa, ty = [], [], []
    z = zipfile.ZipFile(RR_ZIP)
    nm = z.infolist()[0].filename
    with z.open(nm) as f:
        r = csv.reader(io.TextIOWrapper(f, 'utf-8', newline=''))
        next(r)
        for row in r:
            if len(row) > 5 and row[5] == 'ACTIVE' and row[4] in (
                    'IS_DIRECTLY_CONSOLIDATED_BY', 'IS_ULTIMATELY_CONSOLIDATED_BY'):
                a, b = lei2id.get(row[0]), lei2id.get(row[2])
                if a is not None and b is not None:
                    ch.append(a)
                    pa.append(b)
                    ty.append(0 if row[4] == 'IS_DIRECTLY_CONSOLIDATED_BY' else 1)
    np.savez(OUT + 'pairs.npz', child=np.array(ch, dtype=np.int32),
             parent=np.array(pa, dtype=np.int32), type=np.array(ty, dtype=np.int8))
    lap(f'{len(ch):,} consolidation pairs')

    name_len = np.array([len(x) for x in names], dtype=np.int16)
    np.savez(OUT + 'ents.npz', es=np.array(es, dtype=np.int8), rs=np.array(rs, dtype=np.int8),
             cat=np.array(cat, dtype=np.int8), corr=np.array(corr, dtype=np.int8),
             regy=np.array(regy, dtype=np.float32), crey=np.array(crey, dtype=np.float32),
             rel=rel, hasp=hasp, isin=isin, bic=bic, mic=mic, sitelinks=sitelinks,
             name_len=name_len)
    with open(OUT + 'ents_str.pkl', 'wb') as fo:
        pickle.dump({'lei': leis, 'name': names, 'country': ctry, 'lfc': lfc,
                     'rel_types': rel_types, 'RS': RS, 'CAT': CAT}, fo, protocol=4)
    with open(OUT + 'lf_phrases.pkl', 'wb') as fo:
        pickle.dump(lf_used, fo)
    lap('DONE')


if __name__ == '__main__':
    main()
