# 05 · Indexer

Status: approved

## Goal
One command builds the full index from GLEIF's published files, in the format of slice 4,
on a free GitHub-hosted runner. The result is the research index: same entities, same
files, same ranking.

## Scope
- `apps/indexer` (TypeScript, Node 26): download the golden copy (level 1 and level 2) for
  a publish date (default: the latest), and the ISIN and BIC mapping files; stream-parse
  them; compute prominence (port of `ranking.prominence` with `W_RECOMMENDED`); pack the
  files as the research does; write `index.json` and `<build>/*.txt` with
  `packages/core/src/format.ts`.
- Also written per build: `codes.json` with the names of legal forms (ISO 20275 ELF) and
  registration authorities, so pages show "Aktiebolag" and "Bolagsverket", not `XJHM` and
  `RA000544`.
- A check command: reachability, file count, sizes, and the evaluation objective replayed
  over the built files.
- `.github/workflows/build-index.yml`, run by hand: builds on a runner, runs the checks,
  uploads the index as a workflow artifact. Publishing is slice 6.

## Not in scope
- Publishing, scheduling, rollback (slice 6). Sitemaps (slice 6, behind the launch switch).
- Ranking changes (slice 10). Legal-form stripping stays off.

## Approach
Port the Python pipeline step by step: `signals/build_*.py` for the inputs, then the
packing in `engine.py` / `dump_index.py`. Stream everything: the level 1 file is about
500 MB zipped. Unzip with the runner's `unzip -p`; parse CSV with a small tested parser,
no dependency. Compare each stage with the research outputs in `research/data` on the
same inputs.

## Unknowns
- Build time and peak memory on a runner (4 vCPU, 16 GB, 14 GB disk). Target: under 30
  minutes and 8 GB. Measured on the first workflow run.
- Float precision: the research computes prominence partly in float32. A rounded value
  can differ where it sits on a rounding boundary. Counted, and listed if non-zero.

## Done when
On the 2026-09-16 golden copy and the mapping files in `research/data`:
- Prominence: equal to the reference to 1e-6 for every entity; rounded tenths identical
  for all but the boundary cases counted above.
- Files: the same 6,438 bounds, the same capped files, and in every file the same entities
  in the same order as `research/data/index/files.tsv`.
- Reachability 96.7% and index size within 1% of slice 4's 221 MB.
- The replayed evaluation objective equals slice 4's .6516 (tenths).
- The workflow run on a GitHub runner succeeds with its time and memory. Link to run.

## Measured
On the 2026-09-16 golden copy and the mapping files in `research/data`, this sandbox (4
vCPU, one build at a time). Build: `pnpm --filter @whichlei/indexer build --input-dir …
--now-year 2026.74 --research-split --dump-prominence` (research/data has no
`ra-list.csv`, so that command warns and writes a `codes.json` without `ra`; the measurements
above used a copy of the directory with the list from gleif.org); check: `check <dir> --reference
research/data/index --eval`.

- measured: **build 2 min 53 s** wall with the research flags (entities 107 s, grouping 6 s,
  packing 10 s, writing 37 s; the inputs are read from disk, so a runner's download time
  comes on top); 2 min 41 s by default. **Peak RSS 1.84 GB with the research flags, 1.62 GB
  by default** (`process.resourceUsage().maxRSS`; `/usr/bin/time -v` is not installed here,
  the workflow uses it). Check with reference and evaluation: 3 min 27 s, exit 0.
- measured: **6,438 files, 767 capped, 3,317,220 of 3,431,742 entities reachable (96.66%)**,
  1,301,799 terms, 7,495,587 entries (the reference's number). 523.9 MB raw, **220.6 MB
  gzip level 6** (slice 4: 221 MB); per file gzip median 36.3 KB, p90 43.3 KB, max 81.6 KB.
- measured: **bounds 0 differ, capped files identical, every entry's country, status and
  names identical, 0 entries differ in prominence tenths.**
- measured: **prominence, 3,317,220 entities: 0 differ from `entities.tsv` by more than 1e-6**
  (largest 9.54e-7, one float32 step at that size); registration age identical; **0 round to
  a different tenth** (list: none).
- measured: **evaluation objective 0.6516 on the test half (1,613 rows), 0.6571 on all
  3,229 queries**, replayed over the built files: slice 4's .6516.
- measured: **files, 12 of 6,438 differ from `files.tsv` in 26 positions**: 11 adjacent
  swaps of two entities and one rotation of five, all within 1e-6 of prominence of each
  other. Cause below. `check --reference` reports such files as expected (same entities,
  order differing only within 1e-6) and exits 0; any other difference exits 1.
- Workflow run on a GitHub runner: not run yet (the branch is not pushed).

### Differences from the reference, and why
1. **Float32 log, 12 files.** numpy computes `ln(name length)` in float32 with its own
   routine, which differs from the correctly rounded value in the last bit for about 3% of
   lengths (7, 37, 47, 217 …). The port rounds `Math.log` to float32. A prominence then
   differs by one step (≤ 9.54e-7), and entities that tie to within a step swap places.
   The reference's own order depends on the CPU's numpy kernel. No effect on the
   objective.
2. **Names with " | " (64 in the golden copy).** The research wrote an entity's other names
   joined with `" | "` to a TSV and split them again, so a name holding it became two and its
   types shifted (sometimes dropping a name). The indexer keeps such a name whole. 60
   entries differ from the reference by this, 16 files hold different entities (2,765
   positions). `build --research-split` reproduces the research and then shows 0 differing
   entries and the 12 files above.
3. **"Now" for registration age.** The research used 2026.74 for this copy; the indexer
   uses the publish date, 2026-09-16 = 2026.708. `--now-year 2026.74` reproduces the
   reference. Default build, same inputs: same 6,438 files, 3,317,220 reachable,
   objective 0.6515 test, 0.6570 all.
4. **Mapping files by golden copy time.** A download takes the newest `valid` and
   `processed` ISIN and BIC upload from before the golden copy was published, not the
   newest (the research took the newest on the day it fetched). Local inputs are whatever
   the directory holds. The BIC file is uploaded about monthly, so the match can be weeks
   older than the golden copy.
5. **Bad records are skipped and counted** (bad LEI or country, unknown registration status,
   empty legal name; `build.json` lists counts and 20 examples), and the build fails above
   1,000 rows or 0.1%. The golden copy has none. The research read an unknown status as
   MERGED.
6. **Download of the code lists.** The page links are looked up at build time:
   `lei-data/code-lists/iso-20275-entity-legal-forms-code-list` (the research's
   `about-lei/…` URL moved) and `…/gleif-registration-authorities-list`; 3,597 legal forms
   and 1,135 registration authorities in `codes.json`.

### For slice 6
Output: `index.json`, `<build>/0.txt … 6437.txt`, `<build>/codes.json` (the index, 6,440
files, 220.6 MB gzip), plus `build.json` and optionally `prominence.tsv` (not part of the
index). Build id `20260916-<8 hex>`; the same inputs give the same id. Peak memory leaves
room for a 16 GB runner; the build needs `unzip` and Node 26.
