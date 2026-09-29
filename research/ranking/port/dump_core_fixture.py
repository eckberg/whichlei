"""
Reference outputs for the TypeScript port's CI tests (packages/core). Uses only ranking.py
and the committed evaluation set, so it runs from a clean checkout with no data download.

    python3 research/ranking/port/dump_core_fixture.py

Writes packages/core/fixtures/reference.json:
  names    [name, seq, extras] for every entity name in eval/*.tsv plus edge cases
  queries  [query, tokens] for every query in eval/*.tsv plus edge cases
  pool     [id, lei, legal name, P] for every entity in eval/*.tsv; P is a stand-in
           (derived from the LEI), since real prominence needs GLEIF data
  top      [query, top 10 ids] for every 8th distinct query (to keep CI fast; the
           full-scale check covers all), scored against the whole pool
"""
import csv
import glob
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import ranking as R  # noqa: E402

OUT = os.path.join(HERE, '..', '..', '..', 'packages', 'core', 'fixtures', 'reference.json')

EDGE_CASES = [
    '', ' ', 'AT&T Inc.', 'H & M Hennes & Mauritz AB', 'Telefonaktiebolaget L M Ericsson',
    'E.ON SE', 'Coca-Cola HBC AG', 'S.A.', 'A/S Mærsk', 'Ørsted A/S', 'Straße GmbH',
    'Łódź Sp. z o.o.', 'Þór hf.', 'Œuvre', 'İstanbul Menkul', 'KÖNIG & CIE', 'crème brûlée',
    'ÆØÅ', 'naïve café', 'Ｆｕｌｌｗｉｄｔｈ Ｃｏ', 'ﬁnance ﬂow', 'x²', 'Ⅻ Ltd', '株式会社 日本',
    'Банк ВТБ', 'tab\tseparated', 'vt\x0bff\x0c', 'unit\x1fsep',
    'no' + chr(0xa0) + 'break', 'thin' + chr(0x2009) + 'space', 'ideo' + chr(0x3000) + 'space',
    'line' + chr(0x2028) + 'sep', 'zero' + chr(0x200b) + 'width', 'bom' + chr(0xfeff) + 'mark',
    'a b c d', '3M Company', 'I.B.M.', 'A.P. Møller - Mærsk A/S', 'Hennes & Mauritz',
    'the', 'of the and', 'republic of latvia', 'bp', 'sas', 'ericson', 'volv', 'erics',
]


def eval_rows():
    for path in sorted(glob.glob(os.path.join(HERE, '..', 'eval', '*.tsv'))):
        with open(path, encoding='utf-8', newline='') as f:
            yield from csv.DictReader(f, delimiter='\t', quoting=csv.QUOTE_NONE)


def stand_in_prominence(lei):
    return int(hashlib.sha256(lei.encode()).hexdigest()[:8], 16) % 600 / 100 - 3


def main():
    rows = list(eval_rows())
    entities = {}
    for r in rows:
        if r.get('entity_name'):
            entities.setdefault(r['target_lei'], r['entity_name'])
    pool = [[i, lei, name, stand_in_prominence(lei)]
            for i, (lei, name) in enumerate(sorted(entities.items()))]
    entries = []
    for i, _, name, p in pool:
        seq, extras = R.name_tokens(name)
        entries.append({'id': i, 'P': p, 'variants': [(seq, extras, 0, len(seq))]})

    names = list(dict.fromkeys(list(entities.values()) + EDGE_CASES))
    queries = list(dict.fromkeys([r['query'] for r in rows] + EDGE_CASES))
    top = []
    for q in list(dict.fromkeys(r['query'] for r in rows))[::8]:
        Q = R.query_tokens(q)
        top.append([q, [e['id'] for e in R.top_k(Q, entries, R.W_RECOMMENDED)]])

    out = {
        'names': [[n, *R.name_tokens(n)] for n in names],
        'queries': [[q, R.query_tokens(q)] for q in queries],
        'pool': pool,
        'top': top,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    print(f'{len(names)} names, {len(queries)} queries, {len(pool)} pool entities, '
          f'{len(top)} top-10 lists -> {os.path.relpath(OUT)}')


if __name__ == '__main__':
    main()
