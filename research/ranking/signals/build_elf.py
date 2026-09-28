import csv, collections, time

from _paths import BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

with open(BASE + "elf-raw.csv", encoding="utf-8-sig", newline="") as f:
    r = csv.reader(f)
    header = next(r)
    rows = list(r)

# column indices (0-based) per header order
CODE = 0
COUNTRY = 1
COUNTRY_CODE = 2
JURISDICTION = 3
SUBDIV = 4
LOCAL_NAME = 5
LANGUAGE = 6
LANG_CODE = 7
TRANSLIT_NAME = 8
ABBR_LOCAL = 9
ABBR_TRANSLIT = 10
STATUS = 12

by_code = collections.OrderedDict()
for row in rows:
    if len(row) <= STATUS:
        row = row + [""] * (STATUS + 1 - len(row))
    code = row[CODE]
    by_code.setdefault(code, []).append(row)

def clean(s):
    return s.replace("\t", " ").replace("\n", " ").strip()

with open(BASE + "elf.tsv", "w", encoding="utf-8") as out:
    out.write("elf_code\tcountry\tjurisdiction\tlocal_names\tabbreviations\tlanguages\tstatus\n")
    for code, rs in by_code.items():
        country = clean(rs[0][COUNTRY])
        jurisdiction = clean(rs[0][JURISDICTION])
        status = clean(rs[0][STATUS])
        local_names = " | ".join(clean(x[LOCAL_NAME]) for x in rs if x[LOCAL_NAME])
        # gather abbreviations from both local and transliterated abbreviation columns
        abbrs = []
        for x in rs:
            if x[ABBR_LOCAL]:
                abbrs.append(clean(x[ABBR_LOCAL]))
            if x[ABBR_TRANSLIT] and x[ABBR_TRANSLIT] != x[ABBR_LOCAL]:
                abbrs.append(clean(x[ABBR_TRANSLIT]))
        abbreviations = " | ".join(abbrs)
        languages = " | ".join(clean(x[LANGUAGE]) for x in rs if x[LANGUAGE])
        out.write("\t".join([code, country, jurisdiction, local_names, abbreviations, languages, status]) + "\n")

lap(f"wrote elf.tsv codes={len(by_code):,} (raw rows={len(rows):,})")
