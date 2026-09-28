"""
Baseline B1: GLEIF's own API on a 100-query head sample (test split, label queries,
seeded). Max 1 request/second. Raw responses -> eval/b1_raw.jsonl.

  autocompletions  : /api/v1/autocompletions?field=fulltext&q=
  fuzzycompletions : /api/v1/fuzzycompletions?field=entity.legalName&q=
"""
import json
import random
import subprocess
import time
import urllib.parse

from paths import EVAL

SEED = 20260927
N = 100


def fetch(url):
    for attempt in range(4):
        p = subprocess.run(['curl', '-sS', '-m', '30', '-w', '\n%{http_code}', url],
                           capture_output=True, text=True)
        body, _, code = p.stdout.rpartition('\n')
        if code == '200':
            return json.loads(body)
        time.sleep(2 + 3 * attempt)
    return {'error': code, 'stderr': p.stderr[:200]}


def main():
    rows = []
    with open(EVAL + 'head.tsv', encoding='utf-8') as f:
        hdr = f.readline().rstrip('\n').split('\t')
        for line in f:
            d = dict(zip(hdr, line.rstrip('\n').split('\t')))
            if d['split'] == 'test' and d['qtype'] == 'label':
                rows.append(d)
    rng = random.Random(SEED + 10)
    sample = rng.sample(rows, N)
    with open(EVAL + 'b1_sample.tsv', 'w', encoding='utf-8') as f:
        f.write('query\ttarget_lei\talt_leis\n')
        for d in sample:
            f.write(f"{d['query']}\t{d['target_lei']}\t{d['alt_leis']}\n")
    out = open(EVAL + 'b1_raw.jsonl', 'w', encoding='utf-8')
    for i, d in enumerate(sample):
        q = urllib.parse.quote(d['query'])
        for ep, url in (
                ('autocompletions', f'https://api.gleif.org/api/v1/autocompletions?field=fulltext&q={q}'),
                ('fuzzycompletions', f'https://api.gleif.org/api/v1/fuzzycompletions?field=entity.legalName&q={q}')):
            t = time.time()
            js = fetch(url)
            leis = []
            for item in js.get('data', []) if isinstance(js, dict) else []:
                rel = item.get('relationships', {}).get('lei-records', {}).get('data', {})
                if rel.get('id'):
                    leis.append(rel['id'])
            out.write(json.dumps({'query': d['query'], 'target': d['target_lei'],
                                  'alts': d['alt_leis'], 'endpoint': ep, 'leis': leis,
                                  'raw': js}, ensure_ascii=False) + '\n')
            out.flush()
            time.sleep(max(0.0, 1.05 - (time.time() - t)))
        if i % 10 == 0:
            print(i, flush=True)
    out.close()
    print('done')


if __name__ == '__main__':
    main()
