# 07 · Search

Status: approved

## Goal
The real search page. Typing a name searches all 3.4 million LEI records in the browser,
from the published index, as fast as slice 4 measured. It works from the keyboard, with a
screen reader, and in light and dark.

## Scope
- `apps/web` builds a TypeScript page (bundled with esbuild) in place of the prototype, with
  the prototype's look and keys (DESIGN.md decision 11). `design/prototype` stays as a
  reference and is no longer built.
- Search: `queryTokens` → `route` (typing vs paused) → fetch the routed files → decode →
  merge by LEI → `topK`. Files are cached per page load; stale fetches are aborted.
  Results stay on screen while new files load. The manifest's `asOf` is shown.
- Identifiers: a valid LEI shows one row that opens its record; bad check digits say so
  before any request (decision 9). ISIN, BIC and register lookups are slice 8.
- Opening a result goes to `/lei/<code>` (slice 9). The preview shows what the index has:
  LEI, names, country, status.
- Keys: ↑ ↓ select, enter copies the LEI, → opens the record, esc clears, / focuses the
  search, ? shows the about page. ARIA combobox and listbox with `aria-activedescendant`;
  a polite live region announces the result count and copies.
- The font is served from the site, not Google. The CSP allows only the site, the index
  host and the GLEIF API.
- The index host is a build setting; development and tests use a local fixture index.

## Not in scope
- Identifier lookups and the in-page record view (slice 8). Analytics (slice 11).
- A Web Worker for scoring, unless the targets are missed on the main thread.

## Approach
Plain TypeScript and the DOM, no framework. One module owns search state and has no DOM
code, so the page and `tools/bench` drive the same code. The e2e fixture index is the
prototype's 2,924 records encoded with `format.ts`.

## Unknowns
- Whether rendering on top of scoring keeps the slowest keystroke inside the targets.
  Measured with the slice 4 harness on this code.

## What was built
- Search runs in a module Web Worker (`dist/search-worker.js`, DESIGN.md decision 20): the page
  sends `{ seq, text }` for every input; `SearchHost` (`src/search/host.ts`) works on the newest
  only and answers only while it is the newest; `RemoteSearch` (`src/page/remote.ts`) drops answers
  to older inputs and keeps the hits array when nothing changed. Without `Worker` the same
  `Search` runs on the page. CSP: `worker-src 'self'`.
- `apps/web/src/search/`: `IndexClient` (manifest, files cached by `<build>/<n>.txt`, aborts a
  request nobody waits for, one manifest reload on a 404, `parseManifest`) and `Search` (the
  state machine; no DOM). `apps/web/src/page/`: `view.ts` (HTML strings, tested), `keys.ts` (what a
  key means, tested), `main.ts` (focus, history, clipboard, live region). `scripts/build.ts` bundles
  with esbuild; `INDEX_ORIGIN` is a build setting and goes into the bundle and the CSP.
- An index format the page cannot read (`UnsupportedFormatError`) reloads the page once, then
  shows "out of date" with a reload button. A damaged index shows an error.
- Matched parts of names are marked. The cost is in the render numbers below.
- The look is the prototype's. Its CSS now lives in `apps/web/static/` (`shared.css`,
  `search.css`); `design/prototype` is unchanged and no longer built. Rows below the fold use
  `content-visibility: auto`: layout of 50 rows was 25-35 ms of a key at 4× on a phone, now 5.

## Differences from the prototype
- No ISIN, BIC or register-number examples, and the placeholder says "name or lei": those
  lookups are slice 8. A valid LEI shows one row; the preview says the index has no data for it.
- The record view is not in the page: → and "open record" go to `/lei/<code>` (slice 9).
- `about` names the index it reads and its date, from the manifest.

## Measured
`pnpm --filter @whichlei/bench search` (tools/bench/scripts/search.ts) drives `Search` and
`IndexClient` from `apps/web`, not a copy, over the full reference index (3,317,220 entities,
the 2026-09-16 golden copy), in Chromium. Median / p90 / max.

| | Measured | Target |
|---|---|---|
| Bytes per query, debounce on every key (1,607 test queries, gzip) | 148 / 272 / 463 KB | ≤ 150 / 280 / 480 KB |
| Bytes per query, debounce on last key | 64 / 105 / 225 KB | ≤ 65 / 110 / 240 KB |
| Slowest keystroke per query, 4×, debounce on every key | 85 / 141 / 298 ms | ≤ 50 / 80 / 250 ms |
| Same, debounce on last key | 73 / 128 / 277 ms | ≤ 50 / 80 / 250 ms |
| Queries with a keystroke over 100 ms, every key | 36% | ≤ 3% |
| Same, last key | 21% | ≤ 3% |

Bytes match slice 4 to the kilobyte, and the top 10 equals the reference for all 1,607 queries
(0 differ). Timing is every 4th of the 3,229 queries (808 queries, 12,308 keystrokes), at 4×. A
keystroke is the typing pass plus the pause pass, each tokenise, route, decode new files, merge, score;
the slowest single pass is 78 / 122 / 286 ms (every key).

(This section is the main-thread run, before the worker.) **The time targets are missed**, by 35 / 61 / 48 ms at the median, p90 and max (every key), and by
33 pp on the share over 100 ms. Evidence that the machine, not the code, is most of it: this
host was re-measured the same day with slice 4's own harness (`pnpm bench browser`, a single
pass per key, no `Search`): 69 / 109 / 233 ms, against 45 / 73 / 225 ms in slice 4. Slice 4's 6×
run gave 69 / 113 / 371 ms: today's 4× is slice 4's 6×. Against the same-day harness, `Search` is
+22% / +29% / +28% (the pause pass after a typing pass that read other files, and state
handling). In Node, `Search` and the harness cost the same (20 ms median). The numbers need a real
phone (slice 4's unknown, still open) before they decide anything. If they hold, the next step is
the one slice 4 named: scoring in a Web Worker. Done afterwards, see "Measured with the worker".

**Same session, same machine state** (one lock: slice 4's harness, `Search`, the harness again;
4×, the same 808 queries; median / p90 / max, and the share of queries over 100 ms):

| | Slowest keystroke | Over 100 ms |
|---|---|---|
| Slice 4 harness, before and after (single pass per key) | 70.5 / 108 / 245 and 73.7 / 114 / 318 ms | 15.5% and 17.1% |
| `Search`, debounce on every key | 84.6 / 144 / 298 ms | 36.4% |
| `Search`, debounce on last key | 73.3 / 123 / 248 ms | 24.1% |
| Ratio to the harness's first run, every key / last key | 1.20 / 1.33 / 1.22 and 1.04 / 1.14 / 1.01 | |

Slice 4's own run of the harness was 45 / 73 / 225 ms and 2.1%, so this host is 1.56 / 1.48 / 1.09
times slower. Divided by that, `Search` is 54 / 97 / 274 ms with the debounce on every key (misses
p90 by 17 ms and max by 24) and 47 / 83 / 228 ms on the last key (meets median and max, p90 by 3 ms).
Merging the candidates once per file set (kept) did not change the numbers: scoring is the cost.
What the harness does not do is the second pass of an every-key session: the typing pass scores
the files that route while typing, and the pause pass scores again once a long word routes more.

**Render, in the built page**, 390 px wide with touch, 4×, real key presses, a fresh page per query,
every 16th query (202 queries, 3,097 keys), marks included: updating the DOM (build the HTML, set it,
force layout) costs 26 / 47 / 139 ms per key (all the renders of that key together), and the slowest
key of a query 58 / 71 / 139 ms. Event Timing, from the key press to the next paint of its handler:
slowest key per query 128 / 168 / 288 ms (over the 16 ms floor on 99% of keys). Paint is included
there, not in the first number.

Re-run, under the lock when other work shares the machine (about 80 minutes):
```
pnpm --filter @whichlei/bench search --every 4 --page-every 16 --last-every 4   # 4x; --rate N for another
```
Writes `$DATA_DIR/format/search-4x.json`. `--skip bytes,timing,page` leaves parts out.

## Measured with the worker
One locked session on this host (slice 4's harness, the page in three modes, the harness again,
bytes), 4×. Chromium does not throttle workers, so the bench bundles the production worker with a
self-slowdown (after a pass of P ms it spins 3·P ms before it answers; `throttled-worker.ts`). The
page runs under the 4× throttle. Real key presses into the built page, a fresh page per query,
390 px wide with touch. Median / p90 / max. `inthread` is the same page with `Worker` removed.

| | worker, debounce on every key | worker, last key | on the page's thread, every key |
|---|---|---|---|
| Queries | 202 (every 16th) | 808 (every 4th) | 202 |
| Key to first results painted | 118 / 307 / 514 ms | 114 / 184 / 488 ms | 125 / 302 / 428 ms |
| Slowest per query | 354 / 411 / 514 ms | 186 / 316 / 488 ms | 332 / 370 / 428 ms |
| Last key to final results (after the pause pass) | 168 / 278 / 403 ms | 287 / 361 / 511 ms | 168 / 305 / 397 ms |
| Key to next paint, slowest per query | 32 / 48 / 120 ms | under 16 ms | 120 / 168 / 304 ms |
| Queries with a long task over 50 ms | 91% | 60% | 100% |
| Long tasks over 50 ms, total / longest | 704 / 121 ms | 875 / 141 ms | 2,478 / 253 ms |
| DOM update per key (build, set; no layout) | 24 / 47 / 93 ms | n/a | 22 / 42 / 75 ms |

Slice 4's harness, in the same session, before and after: slowest keystroke 71 / 112 / 296 ms and
75 / 114 / 315 ms; 16.1% and 18.8% of queries over 100 ms. Bytes are as before (148 / 272 / 463 KB,
64 / 105 / 225 KB; top 10 equals the reference for all 1,607 queries).

- **Typing no longer waits on search.** Key to next paint falls from 120 / 168 / 304 ms (slowest per
  query) to 32 / 48 / 120 ms, and long tasks from 2,478 to 704 (longest 253 to 121 ms).
- **Long tasks remain, from rendering.** The main thread now runs no search code, only the key
  handler, the message and the DOM update, which is 24 / 47 / 93 ms per key here (50 rows with
  marks, at 4×). Splitting a render over several tasks would remove them; not done.
- **Time to results is not better.** It is the same as on the page's thread (118 vs 125 ms median):
  the work is the same and one thread now does it, plus a hop. The slowest key of a query,
  354 ms median, is mostly the first key of a fresh page (files fetched, code cold) and the
  4× render. It cannot meet slice 4's harness numbers, which leave all of that out. What the worker
  buys is a main thread that is free while it waits.
- Keys 50 ms apart: 5,065 of 12,327 keys get results of their own, the rest are replaced by a
  newer key before they run, which is the point of the newest-only queue.

## What was tried against the render long tasks
Long tasks over 50 ms remain on the main thread at 4× (91% of queries with the debounce on every key,
60% with it on the last; table above). A trace of one query shows what they are: the frame after a
result update, with layout 20-65 ms (about 500 objects, the whole list), paint 15-30 ms and 6-18 ms
of our script. Each was tried in the same locked sessions and kept only if it lowered long tasks:
- Drawing the first 20 rows and the rest in later frames: DOM update 24 / 47 / 93 to 16 / 30 / 57 ms,
  but long tasks did not fall (94% and 79% of queries, more frames) and 8, 20 or 50 rows first gave
  17, 27 and 19 in a 34-key trace. Reverted.
- `contain: content` on the list and preview and `contain: layout` on the main area: 51 and 51 long
  tasks against 43 to 53 for the base, in the same session. Not kept.
- Writing the info line, key bar, footer and attributes only when they changed: 57, 58 and 48 long
  tasks against 49, 54 and 58 for the base. Not kept.
- Kept earlier: `content-visibility: auto` on rows (layout of 50 rows at 4× on a phone, 25-35 to 5 ms).
Per frame the work is about 60 ms at 4×, which is about 15 ms at 1×: inside a 16 ms frame on a
desktop-class CPU. Whether it matters on a phone is for the real-phone check.

## Done when
Final state of the slice.

Met:
- **Bytes per query** 148 / 272 / 463 KB and 64 / 105 / 225 KB (≤ 150 / 280 / 480 and ≤ 65 / 110 /
  240), through the production module; the top 10 equals the reference for all 1,607 test queries.
- **Typing does not wait on search.** Search runs in a worker: key to next paint, slowest per query,
  32 / 48 / 120 ms against 120 / 168 / 304 ms with search on the page's thread; the main thread runs
  no search code. Stale queries are dropped (tested, and measured: with keys 50 ms apart most keys are
  replaced before they run).
- **e2e:** 45 tests (find by name, keys, copy, open, escape, about, LEI good and bad, errors, format
  reload, worker and fallback, fast typing, result numbering, dark mode, phone width). axe reports
  no violations in light or dark on empty, results, error and about states. 348 unit tests, lint
  and typecheck pass.

Not met:
- **Slice 4's keystroke targets** (≤ 50 / 80 / 250 ms, ≤ 3% over 100 ms). On the page's thread the
  slowest keystroke was 85 / 141 / 298 ms with 36% over 100 ms. Slice 4's own harness, in the same
  session, gave 71 / 112 / 296 ms with 16-19% over 100 ms: this host is slower than the one slice 4
  was measured on, and the harness misses the target too. The cost of scoring did not change; it
  moved to a thread that does not block typing.
- **Time to results no worse than the harness's slowest keystroke.** Replaced. The harness leaves out
  the fetch, the thread hop, the render and the frame, so a page cannot match it. In the page, the
  worker's time to results is the same as on the page's thread (118 vs 125 ms median, every key), so
  the worker is not a latency gain; it frees the main thread.
- **"No search long task on the main thread; render long tasks ≤ 50 ms at p90 at 4×."** The first half
  holds by construction. The second does not: 91% of queries (every key) and 60% (last key) have a
  frame over 50 ms (longest 121 and 141 ms), from layout and paint (above). Three changes aimed at it
  did not lower them.

Not measurable here:
- A real phone. 4× CPU slowdown on this host stands in for it, and the worker's slowdown is emulated.
- Live on workers.dev against the published index (slice 6 sets `INDEX_ORIGIN` and the index host's
  CORS header). Screenshots are in the session notes, not committed.

## Status
Built, tested and measured as above. Open: the render long tasks, and the real-phone check that
says whether they matter.
