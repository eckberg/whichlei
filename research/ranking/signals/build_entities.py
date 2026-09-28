import zipfile, io, csv, os, sys, time

from _paths import DATA_DIR, BASE

T0 = time.time()
def lap(m):
    print(f"[{time.time()-T0:8.1f}s] {m}", flush=True)

csv.field_size_limit(2**31 - 1)

IN_ZIP = os.path.join(DATA_DIR, "lei2.csv.zip")
OUT = BASE + "entities.tsv"

z = zipfile.ZipFile(IN_ZIP)
inner_name = z.infolist()[0].filename

def clean(s):
    if s is None:
        return ""
    return s.replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()

OUT_COLS = [
    "lei", "legal_name", "legal_name_lang", "other_names", "other_name_types",
    "transliterated_names", "country", "city", "entity_status", "entity_category",
    "legal_form_code", "legal_form_other", "registration_status",
    "initial_registration_date", "entity_creation_date", "corroboration_level",
]

with z.open(inner_name) as f, open(OUT, "w", encoding="utf-8", newline="") as out:
    tw = io.TextIOWrapper(f, encoding="utf-8", newline="")
    r = csv.reader(tw)
    header = next(r)
    idx = {name: i for i, name in enumerate(header)}

    def col(name):
        return idx[name]

    LEI = col("LEI")
    LEGAL_NAME = col("Entity.LegalName")
    LEGAL_NAME_LANG = col("Entity.LegalName.xmllang")

    OTHER_NAME_COLS = []
    OTHER_TYPE_COLS = []
    for i in range(1, 6):
        base = f"Entity.OtherEntityNames.OtherEntityName.{i}"
        OTHER_NAME_COLS.append(col(base))
        OTHER_TYPE_COLS.append(col(base + ".type"))

    TRANSLIT_COLS = []
    for i in range(1, 6):
        base = f"Entity.TransliteratedOtherEntityNames.TransliteratedOtherEntityName.{i}"
        TRANSLIT_COLS.append(col(base))

    COUNTRY = col("Entity.LegalAddress.Country")
    CITY = col("Entity.LegalAddress.City")
    ENTITY_STATUS = col("Entity.EntityStatus")
    ENTITY_CATEGORY = col("Entity.EntityCategory")
    LEGAL_FORM_CODE = col("Entity.LegalForm.EntityLegalFormCode")
    LEGAL_FORM_OTHER = col("Entity.LegalForm.OtherLegalForm")
    REGISTRATION_STATUS = col("Registration.RegistrationStatus")
    INITIAL_REG_DATE = col("Registration.InitialRegistrationDate")
    ENTITY_CREATION_DATE = col("Entity.EntityCreationDate")
    CORROBORATION_LEVEL = col("Registration.ValidationSources")

    maxidx = max(
        [LEI, LEGAL_NAME, LEGAL_NAME_LANG, COUNTRY, CITY, ENTITY_STATUS,
         ENTITY_CATEGORY, LEGAL_FORM_CODE, LEGAL_FORM_OTHER, REGISTRATION_STATUS,
         INITIAL_REG_DATE, ENTITY_CREATION_DATE, CORROBORATION_LEVEL]
        + OTHER_NAME_COLS + OTHER_TYPE_COLS + TRANSLIT_COLS
    )

    out.write("\t".join(OUT_COLS) + "\n")

    n = 0
    for row in r:
        if len(row) <= maxidx:
            # pad short rows defensively
            row = row + [""] * (maxidx + 1 - len(row))

        other_names = []
        other_types = []
        for nc, tc in zip(OTHER_NAME_COLS, OTHER_TYPE_COLS):
            v = row[nc]
            if v:
                other_names.append(clean(v))
                other_types.append(clean(row[tc]))

        translit_names = []
        for tc in TRANSLIT_COLS:
            v = row[tc]
            if v:
                translit_names.append(clean(v))

        out_row = [
            row[LEI],
            clean(row[LEGAL_NAME]),
            clean(row[LEGAL_NAME_LANG]),
            " | ".join(other_names),
            " | ".join(other_types),
            " | ".join(translit_names),
            clean(row[COUNTRY]),
            clean(row[CITY]),
            clean(row[ENTITY_STATUS]),
            clean(row[ENTITY_CATEGORY]),
            clean(row[LEGAL_FORM_CODE]),
            clean(row[LEGAL_FORM_OTHER]),
            clean(row[REGISTRATION_STATUS]),
            clean(row[INITIAL_REG_DATE]),
            clean(row[ENTITY_CREATION_DATE]),
            clean(row[CORROBORATION_LEVEL]),
        ]
        out.write("\t".join(out_row) + "\n")
        n += 1
        if n % 500000 == 0:
            lap(f"{n:,} rows")

    lap(f"DONE total={n:,}")
