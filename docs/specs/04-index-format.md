# 04 · Index format

Status: approved

## Goal
The index has a fixed format, chosen by measurement on the full corpus, and slice 7 has
numbers to meet: bytes fetched per query and the slowest keystroke on a mid-range phone.
Slices 5–7 share one TypeScript module for it. The format is in
[../index-format.md](../index-format.md).

## Scope
- `packages/core`: `format.ts` (types, file and manifest encode/decode) and `route.ts`
  (`ranking.route_budget`, tested against the reference for every evaluation query,
  every keystroke).
- `tools/bench`: build candidate encodings of the reference index, replay the evaluation
  queries, and time them in Chromium with CPU throttling.

## Not in scope
- Building the index from GLEIF files (slice 5). The measurements use the reference index
  that `research/ranking/port/dump_index.py` writes.
- Publishing, headers and the Worker (slice 6); the page and its rendering (slice 7).

## Approach
Keep the research packing and routing: 6,438 files, a file closes before 1,500 entries, at
most two words route, one file each. Nothing measured argued for a change.

Measured on the 2026-09-16 golden copy: 3,317,220 entities in 7,495,587 entries. Bytes are
gzip level 6; KB is 1,024 bytes, MB 10⁶. Bytes per query: the 1,613 test queries typed one
key at a time, debounce firing on every key. Parse and keystroke times: Chromium at 4×
CPU slowdown, 808 queries (every 4th).

| Encoding | Index | Per query, median / p90 / max | File parse, median | Slowest keystroke, median / p90 |
|---|---|---|---|---|
| **Tab-separated lines (chosen)** | **221 MB** | **148 / 272 / 463 KB** | **16.0 ms** | **45 / 73 ms** |
| JSON arrays, as in the research | 225 MB | 151 / 278 / 475 KB | 14.1 ms | 41 / 69 ms |
| Lines plus pre-tokenised names | 315 MB | 210 / 388 / 689 KB | 6.3 ms | 30 / 59 ms |

- **Lines, not JSON.** 2% fewer bytes on every query; JSON parses 2 ms faster per file at
  4×. A tie on the numbers. Lines win on simplicity: no escaping beyond tab and newline,
  and a file can be parsed line by line as it streams in.
- **Raw names, not pre-tokenised.** Tokens save 10 ms per file at 4× but cost 43% more
  bytes on every query and 94 MB more index.
- **Prominence in tenths.** Against full precision, the top 10 changes order for 1,675 of
  3,229 queries, the first result for 31, and the objective moves .6523 → .6516 (test).
  Hundredths: .6522, for 3% more bytes. Whole numbers: .6503.
- **Entries by prominence, then LEI.** Sorting by name saves 0.8%; prominence order is
  what the cap uses and what a partial list should show.
- **One manifest, immutable build directories.** `index.json` carries the routing table
  (21 KB gzip) and names the build; files live under `<build>/` and cache for a year.
  Content hashes per file were rejected: registration age alone changes 98.4% of files
  overnight, so a hash would save almost nothing. A front-coded routing table is 13 KB,
  not worth a custom parser for 8 KB once per visit.
- **Brotli** (quality 4) is no smaller than gzip here: 223 vs 221 MB.
- **Faster scoring in core, same results.** Scoring was about 70% of the slowest keystroke
  at 4× (a first run over 81 queries: 109 / 214 / 426 ms). The
  one-edit check stopped allocating, `topK` memoises match levels, `fold` skips NFKD for
  ASCII. Node, slowest keystroke per query median / p90: 21.2 / 53.6 → 6.0 / 11.7 ms. The
  parity script still finds every name's tokens and every top 10 identical.

## Unknowns
- Cloudflare's own compression of `text/plain` from a Worker's static assets: assumed
  gzip-6-like. Slice 6 checks `content-encoding` and sizes on a real request.
- Real phones. 4× CPU slowdown on this machine is Lighthouse's mobile setting, a proxy for
  a mid-range phone, not a measurement of one. Slice 7 checks on a real phone.
- Daily churn beyond registration age (new, lapsed and renewed LEIs) needs two golden copies.

## Done when
- The routing port matches `ranking.route_budget` for all 3,229 evaluation queries at every
  keystroke, typing and paused: 49,210 keystrokes identical (`route.test.ts`, in CI).
- Built from the reference index, the chosen format reproduces the reference top 10 for all
  3,229 queries at full precision (0 differences), and every file decodes to what was
  encoded (6,438/6,438).
- In Chromium, the top 10 from the format equals the Node top 10 for every query timed.
- Targets for slice 7, measured with this harness on the production search code:

  | | Measured | Target |
  |---|---|---|
  | Bytes per query, debounce on every key (test) | 148 / 272 / 463 KB | ≤ 150 / 280 / 480 KB |
  | Bytes per query, debounce on last key (test) | 64 / 105 / 225 KB | ≤ 65 / 110 / 240 KB |
  | Slowest keystroke per query, 4× (all 3,229) | 45 / 74 / 222 ms | ≤ 50 / 80 / 250 ms |
  | Queries with a keystroke over 100 ms, 4× | 2.7% | ≤ 3% |
  | Slowest keystroke per query, 6× (all 3,229) | 69 / 113 / 371 ms; 16% over 100 ms | reported |
  | Every keystroke, 4× (49,159) | 22 / 49 / 222 ms | reported |
  | Index file parse, 4× (all 6,438) | 17 / 28 / 91 ms | ≤ 20 / 30 / 100 ms |
  | Manifest parse, 4× | 5 ms | ≤ 10 ms |

  Median / p90 / max. A keystroke is tokenise, route, parse newly arrived files, merge and
  score, on the main thread, with the debounce firing on every key; rendering comes on top.
  The 49,159 timed keystrokes are the 49,210 routed ones less 51 that have no tokens.
  At 1×: 9 / 16 / 53 ms. The slowest queries are long legal names typed in full, every
  word scored against up to 3,000 candidates. If slice 7 misses a target, the next step
  is scoring in a Web Worker, off the main thread, not a format change.

## Re-run
```
python3 research/ranking/port/dump_index.py      # after prep.py; reference index -> $DATA_DIR/index
python3 research/ranking/port/dump_parity.py     # if $DATA_DIR/parity is missing
pnpm --filter @whichlei/bench build-index        # encodings, sizes, churn (~8 min)
pnpm --filter @whichlei/bench replay             # bytes per query, top 10 (~7 min)
pnpm --filter @whichlei/bench browser --rates 4 --every 4 --files-every 4   # encodings (~20 min)
pnpm --filter @whichlei/bench browser --encodings lines                    # 1x, 4x, 6x (~80 min)
```
With `DATA_DIR` set as in CLAUDE.md. Outputs, all in `$DATA_DIR/format/`: `sizes.json`,
`replay.json`, `browser-*.json`. `pnpm --filter @whichlei/bench score` times scoring alone
in Node, for quick comparisons.
