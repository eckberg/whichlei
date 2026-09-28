"""Wikidata sitelinks signal: every Wikidata item with an LEI (property P6533), its
English label, English aliases, sitelink count and instance-of classes.

Two live calls to the public Wikidata Query Service: one for the (item, LEI) pairs,
then one detail query per batch of 300 items. Wikidata is live, so this is not
pinned to the GLEIF publish date and re-running it can pick up a different, larger
snapshot (new LEIs get added to Wikidata continuously) -- see the README.
"""
import json, time, subprocess

from _paths import BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

UA = "whichlei-ranking-research/0.1 (https://whichlei.com)"
ENDPOINT = "https://query.wikidata.org/sparql"


def run_query(query, retries=5):
    delay = 1.0
    for attempt in range(retries):
        proc = subprocess.run(
            ["curl", "-sS", "-G", ENDPOINT,
             "-H", f"User-Agent: {UA}",
             "-H", "Accept: application/sparql-results+json",
             "--data-urlencode", f"query={query}",
             "-w", "\n__HTTP__%{http_code}",
             "--max-time", "60"],
            capture_output=True, text=True,
        )
        out = proc.stdout
        if "__HTTP__" in out:
            body, code_part = out.rsplit("\n__HTTP__", 1)
            code = code_part.strip()
        else:
            body, code = out, "000"
        if code == "200":
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                lap(f"JSON decode error, retrying (attempt {attempt+1})")
        elif code == "429":
            lap(f"429 rate limited, backing off {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        else:
            lap(f"HTTP {code} stderr={proc.stderr[:200]!r} retrying (attempt {attempt+1})")
            time.sleep(delay)
            delay = min(delay * 2, 30)
    raise RuntimeError("query failed after retries")


def fetch_pairs():
    """(item, lei) for every Wikidata item with an LEI (P6533)."""
    res = run_query("SELECT ?item ?lei WHERE { ?item wdt:P6533 ?lei . }")
    pairs = []
    for b in res["results"]["bindings"]:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        pairs.append((qid, b["lei"]["value"]))
    return pairs


def main():
    pairs = fetch_pairs()
    lap(f"loaded {len(pairs):,} (qid, lei) pairs")

    distinct_qids = sorted(set(q for q, _ in pairs))
    lap(f"distinct qids: {len(distinct_qids):,}")

    BATCH = 300
    detail = {}  # qid -> dict(label_en, aliases_en, sitelinks, instance_of)

    n_batches = (len(distinct_qids) + BATCH - 1) // BATCH
    for bi in range(n_batches):
        chunk = distinct_qids[bi * BATCH:(bi + 1) * BATCH]
        values = " ".join(f"wd:{q}" for q in chunk)
        query = f"""
SELECT ?item ?itemLabel ?sitelinks
  (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
  (GROUP_CONCAT(DISTINCT ?instanceOfId; separator="|") AS ?instances)
WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }}
  OPTIONAL {{ ?item wikibase:sitelinks ?sitelinks . }}
  OPTIONAL {{ ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }}
  OPTIONAL {{ ?item wdt:P31 ?instanceOf . BIND(STRAFTER(STR(?instanceOf), "entity/") AS ?instanceOfId) }}
}}
GROUP BY ?item ?itemLabel ?sitelinks
"""
        res = run_query(query)
        for row in res["results"]["bindings"]:
            qid = row["item"]["value"].rsplit("/", 1)[-1]
            label = row.get("itemLabel", {}).get("value", "")
            sitelinks = row.get("sitelinks", {}).get("value", "")
            aliases = row.get("aliases", {}).get("value", "")
            instances = row.get("instances", {}).get("value", "")
            detail[qid] = {
                "label_en": label,
                "aliases_en": aliases.replace("|", " | "),
                "sitelinks": sitelinks,
                "instance_of": instances.replace("|", " | "),
            }
        if bi % 10 == 0 or bi == n_batches - 1:
            lap(f"batch {bi+1}/{n_batches} done, detail so far={len(detail):,}")
        time.sleep(1.05)  # keep rate modest, ~1 req/sec

    lap(f"all batches done, details for {len(detail):,} / {len(distinct_qids):,} qids")

    # --- load entities.tsv LEIs for filtering ---
    valid_leis = set()
    with open(BASE + "entities.tsv", encoding="utf-8") as f:
        header = f.readline().rstrip("\n").split("\t")
        lei_idx = header.index("lei")
        for line in f:
            parts = line.rstrip("\n").split("\t", lei_idx + 1)
            if len(parts) > lei_idx:
                valid_leis.add(parts[lei_idx])

    lap(f"loaded {len(valid_leis):,} valid LEIs from entities.tsv")

    kept = 0
    dropped = 0
    with open(BASE + "wikidata.tsv", "w", encoding="utf-8") as out:
        out.write("qid\tlei\tlabel_en\taliases_en\tsitelinks\tinstance_of\n")
        for qid, lei in pairs:
            if lei not in valid_leis:
                dropped += 1
                continue
            info = detail.get(qid, {})
            label = info.get("label_en", "").replace("\t", " ").replace("\n", " ")
            aliases = info.get("aliases_en", "").replace("\t", " ").replace("\n", " ")
            sitelinks = info.get("sitelinks", "")
            instances = info.get("instance_of", "").replace("\t", " ").replace("\n", " ")
            out.write(f"{qid}\t{lei}\t{label}\t{aliases}\t{sitelinks}\t{instances}\n")
            kept += 1

    lap(f"wrote wikidata.tsv kept={kept:,} dropped(no matching LEI in entities.tsv)={dropped:,}")
    lap("DONE")


if __name__ == "__main__":
    main()
