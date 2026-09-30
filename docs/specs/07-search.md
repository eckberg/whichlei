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

**The time targets are missed**, by 35 / 61 / 48 ms at the median, p90 and max (every key), and by
33 pp on the share over 100 ms. Evidence that the machine, not the code, is most of it: this
host was re-measured the same day with slice 4's own harness (`pnpm bench browser`, a single
pass per key, no `Search`): 69 / 109 / 233 ms, against 45 / 73 / 225 ms in slice 4. Slice 4's 6×
run gave 69 / 113 / 371 ms: today's 4× is slice 4's 6×. Against the same-day harness, `Search` is
+22% / +29% / +28% (the pause pass after a typing pass that read other files, and state
handling). In Node, `Search` and the harness cost the same (20 ms median). The numbers need a real
phone (slice 4's unknown, still open) before they decide anything. If they hold, the next step is
the one slice 4 named: scoring in a Web Worker. Not done: it needs the owner's word.

**Render, in the built page**, 390 px wide with touch, 4×, real key presses, a fresh page per query,
every 16th query (202 queries, 3,097 keys), marks included: updating the DOM (build the HTML, set it,
force layout) costs 26 / 47 / 139 ms per key (all the renders of that key together), and the slowest
key of a query 58 / 71 / 139 ms. Event Timing, from the key press to the next paint of its handler:
slowest key per query 128 / 168 / 288 ms (over the 16 ms floor on 99% of keys). Paint is included
there, not in the first number.

Re-run, under the lock when other work shares the machine (about 70 minutes):
```
pnpm --filter @whichlei/bench search --every 4 --render-every 16   # 4x; --rate N for another
```
Writes `$DATA_DIR/format/search-4x.json`. `--skip bytes,timing,render` leaves parts out.

## Done when
- The slice 4 targets, measured with `tools/bench` on the production search module at 4×:
  bytes per query ≤ 150 / 280 / 480 KB, slowest keystroke ≤ 50 / 80 / 250 ms (plus
  rendering, reported), at most 3% of queries over 100 ms.
- e2e tests: find by name, keyboard flow, copy, esc, about, LEI with good and bad check
  digits, open record, dark mode. axe reports no violations in either theme.
- Live on workers.dev against the published index (after slice 6). Screenshots.

## Status
- Built and tested: 42 e2e tests pass (find, keys, copy, open, escape, about, LEI good and bad,
  errors, format reload, dark mode, phone width, axe in light and dark on four states, none
  reported). 336 unit tests pass.
- Open: the speed targets (above), a check on a real phone, and live on workers.dev against the
  published index (slice 6 sets `INDEX_ORIGIN` and the index host's CORS header).
