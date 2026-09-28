"""
Index-size impact: serialise every shard file as the client would receive it (JSON,
gzip -6) for a given config and entry format, and sum.

Entry formats
  base   [lei, legal_name, country]                                   (the compact format)
  +P     [lei, legal_name, country, P]    P quantised to 0.1 (int, x10)
  +alt   + list of indexed alternative names (only when the entity has any)
"""
import gzip
import json

import numpy as np

import engine as EN
from paths import SIG


def alt_names(idx, e):
    out = []
    a, b = idx.eptr[e], idx.eptr[e + 1]
    for r in range(a, b):
        if idx.row_on[r] and idx.row_type[r] != 0:
            out.append(r)
    return out


def measure(idx, kept, P, fmt=('base',), sample_every=1):
    """Returns total gz bytes (extrapolated if sample_every > 1), p50/p90/max per file."""
    E = EN.ents()
    lei, name, ctry = E['lei'], E['name'], E['country']
    kptr, kents = kept
    need_alt = '+alt' in fmt
    if need_alt:
        import csv
        alt = load_alt_strings(idx)
    sizes = []
    for f in range(0, len(kptr) - 1, sample_every):
        es = kents[kptr[f]:kptr[f + 1]]
        es = es[np.lexsort((es, -P[es]))]                 # entry order = P desc
        entries = []
        for e in es:
            x = [lei[e], name[e], ctry[e]]
            if '+P' in fmt:
                x.append(int(round(P[e] * 10)))
            if need_alt and e in alt:
                x.append(alt[e])
            entries.append(x)
        blob = json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()
        sizes.append(len(gzip.compress(blob, 6)))
    s = np.array(sizes)
    return {'files': len(kptr) - 1, 'total_MB': s.sum() * sample_every / 1e6,
            'p50_KB': float(np.median(s)) / 1024, 'p90_KB': float(np.percentile(s, 90)) / 1024,
            'max_KB': float(s.max()) / 1024, 'entries': int(kptr[-1]),
            'sizes': s.tolist() if sample_every == 1 else None}


_ALT = None


def load_alt_strings(idx):
    """entity id -> list of alternative name strings for the indexed variant types."""
    global _ALT
    if _ALT is not None:
        return _ALT
    VT = {'TRADING_OR_OPERATING_NAME': 1, 'ALTERNATIVE_LANGUAGE_LEGAL_NAME': 2,
          'PREVIOUS_LEGAL_NAME': 4}
    types = set(idx.types)
    out = {}
    with open(SIG + 'entities.tsv', encoding='utf-8') as f:
        h = f.readline().rstrip('\n').split('\t')
        H = {k: i for i, k in enumerate(h)}
        for eid, line in enumerate(f):
            p = line.rstrip('\n').split('\t')
            names = []
            if p[H['other_names']]:
                for nm, ty in zip(p[H['other_names']].split(' | '), p[H['other_name_types']].split(' | ')):
                    if VT.get(ty, 4) in types:
                        names.append(nm)
            if 3 in types and p[H['transliterated_names']]:
                names += p[H['transliterated_names']].split(' | ')
            names = [n for n in dict.fromkeys(names) if n != p[1]]
            if names:
                out[eid] = names
    _ALT = out
    return out
