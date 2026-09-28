# GLEIF typeahead ranking

Research behind the ranking, index packing and query routing for whichlei.com, a free
typeahead search over all GLEIF Legal Entity Identifier (LEI) records.

## Run

    export DATA_DIR=/path/to/data      # default: research/data, gitignored
    python3 fetch_data.py              # downloads GLEIF + mapping files, builds signals/
    pip install -r requirements.txt
    SKIP_B1=1 ./run_all.sh             # ~40 min; drop SKIP_B1 to also hit the GLEIF API

`fetch_data.py` pins the GLEIF golden-copy publish date (default 2026-09-16). The
ISIN/BIC/MIC mapping files and the ELF code list are not pinnable by date (GLEIF
exposes only the latest upload). `REBUILD_EVAL=1` rebuilds `eval/*.tsv` from live
Wikidata data instead of using the committed copies; not exactly reproducible.

## Results

`results.md` has every number; `eval/METHOD.md` describes the evaluation set.
