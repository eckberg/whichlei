"""Tokenise legal names for baseline B0: simpler folding than the main tokenizer.
v2: fold (explicit table + NFKD), [a-z0-9]+ runs, drop tokens < 2 chars, dedupe."""
import pickle
import re
import unicodedata

import numpy as np

from paths import CACHE

TRANS = str.maketrans({'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ß': 'ss', 'ł': 'l', 'Ł': 'l',
                       'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'œ': 'oe',
                       'Œ': 'oe', 'ı': 'i', 'ŋ': 'n', 'ħ': 'h'})
WORD = re.compile(r'[a-z0-9]+')


def fold(s):
    s = s.translate(TRANS)
    s = unicodedata.normalize('NFKD', s)
    return ''.join(c for c in s if not unicodedata.combining(c)).lower()


def v2_tokens(s):
    out, seen = [], set()
    for w in WORD.findall(fold(s)):
        if len(w) < 2 or w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out


def main():
    S = pickle.load(open(CACHE + 'ents_str.pkl', 'rb'))
    vocab, seqs = {}, []
    for nm in S['name']:
        ids = []
        for w in v2_tokens(nm):
            i = vocab.get(w)
            if i is None:
                i = vocab[w] = len(vocab)
            ids.append(i)
        seqs.append(ids)
    words = sorted(vocab)
    remap = np.empty(len(vocab), dtype=np.int32)
    for new, w in enumerate(words):
        remap[vocab[w]] = new
    N = len(seqs)
    tptr = np.zeros(N + 1, dtype=np.int64)
    tptr[1:] = np.cumsum([len(x) for x in seqs])
    tok = remap[np.fromiter((i for x in seqs for i in x), dtype=np.int32, count=int(tptr[-1]))]
    lens = np.diff(tptr).astype(np.int16)
    np.savez(CACHE + 'rows_v2.npz', row_ent=np.arange(N, dtype=np.int32),
             row_type=np.zeros(N, dtype=np.int8), tptr=tptr, tok=tok,
             xptr=np.zeros(N + 1, dtype=np.int64), ext=np.zeros(0, dtype=np.int32),
             cs=np.zeros(N, dtype=np.int16), ce=lens)
    pickle.dump(words, open(CACHE + 'vocab_v2.pkl', 'wb'), protocol=4)
    print('v2 rows', N, 'vocab', len(words))


if __name__ == '__main__':
    main()
