import zipfile, io, csv, os, time, collections

from _paths import DATA_DIR, BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

csv.field_size_limit(2**31 - 1)

IN_ZIP = os.path.join(DATA_DIR, "rr.csv.zip")
OUT_REL = BASE + "relationships.tsv"
OUT_HASPARENT = BASE + "has_parent.tsv"

DIRECT_TYPE = "IS_DIRECTLY_CONSOLIDATED_BY"
ULTIMATE_TYPE = "IS_ULTIMATELY_CONSOLIDATED_BY"

z = zipfile.ZipFile(IN_ZIP)
inner_name = z.infolist()[0].filename

# parent_lei -> Counter(relationship_type -> count)
parent_counts = collections.defaultdict(collections.Counter)
all_types = set()

# child_lei -> set of relationship types (for has_parent)
child_has_direct = set()
child_has_ultimate = set()

n = 0
n_active = 0
with z.open(inner_name) as f:
    tw = io.TextIOWrapper(f, encoding="utf-8", newline="")
    r = csv.reader(tw)
    header = next(r)
    idx = {name: i for i, name in enumerate(header)}
    START = idx["Relationship.StartNode.NodeID"]
    END = idx["Relationship.EndNode.NodeID"]
    RTYPE = idx["Relationship.RelationshipType"]
    RSTATUS = idx["Relationship.RelationshipStatus"]
    maxidx = max(START, END, RTYPE, RSTATUS)

    for row in r:
        n += 1
        if len(row) <= maxidx:
            continue
        if row[RSTATUS] != "ACTIVE":
            continue
        n_active += 1
        child = row[START]
        parent = row[END]
        rtype = row[RTYPE]
        all_types.add(rtype)
        parent_counts[parent][rtype] += 1
        if rtype == DIRECT_TYPE:
            child_has_direct.add(child)
        elif rtype == ULTIMATE_TYPE:
            child_has_ultimate.add(child)

lap(f"parsed {n:,} rows, {n_active:,} ACTIVE, {len(all_types)} distinct types: {sorted(all_types)}")

type_list = sorted(all_types)

with open(OUT_REL, "w", encoding="utf-8", newline="") as out:
    out.write("\t".join(["lei"] + type_list) + "\n")
    for parent_lei in sorted(parent_counts):
        counts = parent_counts[parent_lei]
        out.write("\t".join([parent_lei] + [str(counts.get(t, 0)) for t in type_list]) + "\n")

lap(f"wrote relationships.tsv rows={len(parent_counts):,}")

all_children = child_has_direct | child_has_ultimate
with open(OUT_HASPARENT, "w", encoding="utf-8", newline="") as out:
    out.write("lei\thas_direct_parent\thas_ultimate_parent\n")
    for child_lei in sorted(all_children):
        out.write(f"{child_lei}\t{1 if child_lei in child_has_direct else 0}\t{1 if child_lei in child_has_ultimate else 0}\n")

lap(f"wrote has_parent.tsv rows={len(all_children):,}")
lap("DONE")
