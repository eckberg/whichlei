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
