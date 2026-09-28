"""Compact per-entity extract from the level-1 (lei2) golden copy: LEI, legal name,
country, city, entity status, registration status, category, registration authority
ID. Not read by the ranking pipeline itself (see prep.py, which reads the richer
signals/entities.tsv); kept for the index-size measurements in results.md."""
import csv
import io
import os
import zipfile

from paths import DATA_DIR

IN_ZIP = os.path.join(DATA_DIR, 'lei2.csv.zip')
OUT = os.path.join(DATA_DIR, 'compact.tsv')
LEI, NAME, CITY, CC, EST, RST, CAT, RAID = 0, 1, 41, 43, 199, 315, 191, 189

z = zipfile.ZipFile(IN_ZIP)
name = z.infolist()[0].filename
out = open(OUT, 'w', encoding='utf-8')
n = 0
csv.field_size_limit(10**7)
with z.open(name) as f:
    r = csv.reader(io.TextIOWrapper(f, 'utf-8', newline=''))
    next(r)
    for row in r:
        try:
            nm = row[NAME].replace('\t', ' ').replace('\n', ' ').strip()
            if not nm:
                continue
            out.write('\t'.join((row[LEI], nm, row[CC], row[CITY].replace('\t', ' ').strip(),
                                 row[EST], row[RST], row[CAT], row[RAID].replace('\t', ' ').strip())) + '\n')
            n += 1
            if n % 500000 == 0:
                print(n, flush=True)
        except IndexError:
            continue
out.close()
print('TOTAL', n)
