#!/usr/bin/env python3
"""
Fetch every raw input this study needs and build the derived signal files.

  DATA_DIR         where files land (env var; default: research/data, next to this dir)
  --publish-date    GLEIF golden-copy publish date, YYYY-MM-DD (default 2026-09-16)

Downloads the level-1 (lei2) and relationship (rr) golden copies for the pinned
publish date (resolved through the GLEIF golden-copy API), the ISIN/BIC/MIC mapping
files and the ELF code list, then runs extract.py and the signal builders (see
signals/). The four mapping/code-list files are NOT pinnable by publish date: GLEIF's
mapping API only exposes the most recent upload, and the code-list page only the
current CSV -- see the README.

A file that already exists locally is not re-downloaded; its URL is still checked
(HEAD, falling back to a 1-byte range request) so a broken link is still caught.

Usage:
  python3 fetch_data.py                # full pipeline
  python3 fetch_data.py --check-only   # resolve + verify every URL, download nothing
  python3 fetch_data.py --skip-wikidata  # skip the live Wikidata signal pull
"""
import argparse
import json
import os
import re
import subprocess

from paths import DATA_DIR as DEFAULT_DATA_DIR

PUBLISHES_API = "https://goldencopy.gleif.org/api/v2/golden-copies/publishes"
MAPPING_API = "https://mapping.gleif.org/api/v2/{kind}"
ELF_LIST_PAGE = "https://www.gleif.org/en/about-lei/code-lists/iso-20275-entity-legal-forms-code-list"


def curl_json(url):
    p = subprocess.run(["curl", "-sS", "-m", "30", url], capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def curl_text(url):
    p = subprocess.run(["curl", "-sS", "-L", "-m", "30", url], capture_output=True, text=True, check=True)
    return p.stdout


def url_resolves(url):
    """HEAD, falling back to a 1-byte range GET. True on any 2xx/3xx."""
    for extra in (["-I"], ["-r", "0-0"]):
        p = subprocess.run(["curl", "-sS", "-L", "-m", "20", "-o", "/dev/null",
                            "-w", "%{http_code}", *extra, url], capture_output=True, text=True)
        code = p.stdout.strip()
        if code[:1] in ("2", "3"):
            return True
    return False


def download(url, dest, force=False):
    if os.path.exists(dest) and os.path.getsize(dest) > 0 and not force:
        ok = url_resolves(url)
        print(f"  have {dest} ({os.path.getsize(dest):,} bytes) -- "
              f"url {'resolves' if ok else 'DOES NOT RESOLVE'}, not re-downloading")
        if not ok:
            raise RuntimeError(f"{url} does not resolve and no fresh copy was fetched")
        return
    print(f"  downloading {url}\n    -> {dest}")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    subprocess.run(["curl", "-sS", "-L", "-m", "1800", "-o", tmp, url], check=True)
    os.replace(tmp, dest)


def resolve_publish(date, time_of_day="08:00:00"):
    """Walk the paginated, newest-first publishes API for the given date."""
    target = f"{date} {time_of_day}"
    page = 1
    while True:
        d = curl_json(f"{PUBLISHES_API}?page={page}")
        rows = d["data"]
        if not rows:
            raise RuntimeError(f"publish date {date} not found (ran out of pages)")
        for row in rows:
            if row["publish_date"] == target:
                return row
        if rows[-1]["publish_date"] < target:
            same_day = [r for r in rows if r["publish_date"].startswith(date)]
            if same_day:
                return same_day[0]
            raise RuntimeError(f"publish date {date} not found")
        page += 1


def latest_mapping(kind):
    """kind: isin-lei | bic-lei | mic-lei. (url, filename) of the most recent upload --
    GLEIF's mapping API does not expose historical uploads by date."""
    d = curl_json(MAPPING_API.format(kind=kind))
    row = d["data"][0]
    return row["attributes"]["downloadLink"], row["attributes"]["fileName"]


def elf_list_url():
    html = curl_text(ELF_LIST_PAGE)
    m = re.search(r'href="(https://www\.gleif\.org/[^"]*\.csv)"', html)
    if not m:
        raise RuntimeError("could not find the ELF code-list CSV link on the GLEIF page")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish-date", default="2026-09-16")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR)
    ap.add_argument("--check-only", action="store_true", help="resolve + verify URLs, download nothing")
    ap.add_argument("--skip-wikidata", action="store_true", help="skip the live Wikidata signal pull")
    ap.add_argument("--force", action="store_true", help="re-download even if the file already exists")
    a = ap.parse_args()

    data_dir = os.path.abspath(a.data_dir)
    sig_dir = os.path.join(data_dir, "signals")
    os.makedirs(sig_dir, exist_ok=True)

    print(f"publish date: {a.publish_date}  data dir: {data_dir}")
    publish = resolve_publish(a.publish_date)
    lei2_url = publish["lei2"]["full_file"]["csv"]["url"]
    rr_url = publish["rr"]["full_file"]["csv"]["url"]
    isin_url, isin_name = latest_mapping("isin-lei")
    bic_url, bic_name = latest_mapping("bic-lei")
    mic_url, mic_name = latest_mapping("mic-lei")
    elf_url = elf_list_url()

    plan = [
        (lei2_url, os.path.join(data_dir, "lei2.csv.zip")),
        (rr_url, os.path.join(data_dir, "rr.csv.zip")),
        (isin_url, os.path.join(sig_dir, "isin-lei.zip")),
        (bic_url, os.path.join(sig_dir, "bic-lei.zip")),
        (mic_url, os.path.join(sig_dir, "mic-lei.zip")),
        (elf_url, os.path.join(sig_dir, "elf-raw.csv")),
    ]
    print(f"resolved: lei2 {publish['lei2']['publish_date']}  rr {publish['rr']['publish_date']}")
    print("mapping files are NOT pinned by publish date (GLEIF's API exposes only the latest upload):")
    print(f"  isin-lei {isin_name}  bic-lei {bic_name}  mic-lei {mic_name}")

    if a.check_only:
        for url, _ in plan:
            print(f"  {'OK' if url_resolves(url) else 'FAIL'}  {url}")
        return

    for url, dest in plan:
        download(url, dest, force=a.force)

    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, DATA_DIR=data_dir)

    def run(*cmd):
        print(f"  running {' '.join(cmd)}")
        subprocess.run(cmd, check=True, cwd=here, env=env)

    run("python3", "extract.py")
    run("python3", "signals/build_entities.py")
    run("python3", "signals/build_relationships.py")
    run("python3", "signals/build_mappings.py")
    run("python3", "signals/build_elf.py")
    run("python3", "signals/build_legal_form_tokens.py")
    if not a.skip_wikidata:
        run("python3", "signals/build_wikidata.py")
    elif not os.path.exists(os.path.join(sig_dir, "wikidata.tsv")):
        print("  --skip-wikidata was passed but signals/wikidata.tsv does not exist yet;")
        print("  prep.py needs it -- run signals/build_wikidata.py separately, or drop --skip-wikidata.")

    print("DONE")


if __name__ == "__main__":
    main()
