import unicodedata, re, collections, time, csv

from _paths import BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

csv.field_size_limit(2**31 - 1)

# explicit fold table, applied BEFORE Unicode NFKD
TRANS = str.maketrans({
    'æ': 'ae', 'Æ': 'ae',
    'ø': 'o', 'Ø': 'o',
    'ß': 'ss',
    'ł': 'l', 'Ł': 'l',
    'đ': 'd', 'Đ': 'd',
    'ð': 'd', 'Ð': 'd',
    'þ': 'th', 'Þ': 'th',
    'œ': 'oe', 'Œ': 'oe',
})

def fold(s):
    s = s.translate(TRANS)
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return s.lower()

WORD = re.compile(r"[a-z0-9]+")

def tokens_of(s):
    return WORD.findall(fold(s))

# --- Step 1: collect candidate tokens from ELF abbreviations + local names ---
token_source_rows = 0
candidate_tokens = set()
with open(BASE + "elf-raw.csv", encoding="utf-8-sig", newline="") as f:
    r = csv.reader(f)
    header = next(r)
    idx = {name: i for i, name in enumerate(header)}
    LOCAL_NAME = idx["Entity Legal Form name Local name"]
    ABBR_LOCAL = idx["Abbreviations Local language"]
    ABBR_TRANSLIT = idx["Abbreviations transliterated"]
    TRANSLIT_NAME = idx["Entity Legal Form name Transliterated name (per ISO 01-140-10)"]
    for row in r:
        token_source_rows += 1
        for col in (LOCAL_NAME, ABBR_LOCAL, ABBR_TRANSLIT, TRANSLIT_NAME):
            if col < len(row) and row[col]:
                for t in tokens_of(row[col]):
                    if len(t) >= 1:
                        candidate_tokens.add(t)

lap(f"ELF source rows={token_source_rows:,}; candidate tokens={len(candidate_tokens):,}")

# --- Step 2: count corpus frequency (whole word) across entities.tsv legal_name ---
freq = collections.Counter()
n = 0
with open(BASE + "entities.tsv", encoding="utf-8") as f:
    header = f.readline().rstrip("\n").split("\t")
    name_idx = header.index("legal_name")
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) <= name_idx:
            continue
        name = parts[name_idx]
        if not name:
            continue
        toks = set(tokens_of(name))
        for t in toks:
            if t in candidate_tokens:
                freq[t] += 1
        n += 1
        if n % 1000000 == 0:
            lap(f"{n:,} legal names scanned")

lap(f"scanned {n:,} legal names total")

with open(BASE + "legal_form_tokens.tsv", "w", encoding="utf-8") as out:
    out.write("token\tcorpus_frequency\n")
    # include all candidate tokens, even those with 0 corpus hits, sorted by freq desc then token asc
    rows = [(t, freq.get(t, 0)) for t in candidate_tokens]
    rows.sort(key=lambda x: (-x[1], x[0]))
    for t, c in rows:
        out.write(f"{t}\t{c}\n")

lap(f"wrote legal_form_tokens.tsv rows={len(rows):,}")
