import zipfile, io, csv, collections, time

from _paths import BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

csv.field_size_limit(2**31 - 1)

# --- ISIN count ---
isin_counts = collections.Counter()
z = zipfile.ZipFile(BASE + "isin-lei.zip")
name = z.infolist()[0].filename
with z.open(name) as f:
    r = csv.reader(io.TextIOWrapper(f, "utf-8", newline=""))
    header = next(r)
    assert header == ["LEI", "ISIN"], header
    n = 0
    for row in r:
        if len(row) < 2:
            continue
        isin_counts[row[0]] += 1
        n += 1
lap(f"isin rows read: {n:,}, distinct LEIs: {len(isin_counts):,}")

with open(BASE + "isin_count.tsv", "w", encoding="utf-8") as out:
    out.write("lei\tisin_count\n")
    for lei, c in sorted(isin_counts.items()):
        out.write(f"{lei}\t{c}\n")
lap("wrote isin_count.tsv")

# --- BIC ---
z = zipfile.ZipFile(BASE + "bic-lei.zip")
name = z.infolist()[0].filename
n = 0
with z.open(name) as f, open(BASE + "bic.tsv", "w", encoding="utf-8") as out:
    r = csv.reader(io.TextIOWrapper(f, "utf-8", newline=""))
    header = next(r)
    assert header == ["LEI", "BIC"], header
    out.write("lei\tbic\n")
    for row in r:
        if len(row) < 2:
            continue
        out.write(f"{row[0]}\t{row[1]}\n")
        n += 1
lap(f"wrote bic.tsv rows={n:,}")

# --- MIC ---
z = zipfile.ZipFile(BASE + "mic-lei.zip")
name = z.infolist()[0].filename
n = 0
with z.open(name) as f, open(BASE + "mic.tsv", "w", encoding="utf-8") as out:
    r = csv.reader(io.TextIOWrapper(f, "utf-8", newline=""))
    header = next(r)
    assert header == ["LEI", "MIC"], header
    out.write("lei\tmic\n")
    for row in r:
        if len(row) < 2:
            continue
        out.write(f"{row[0]}\t{row[1]}\n")
        n += 1
lap(f"wrote mic.tsv rows={n:,}")
lap("DONE")
