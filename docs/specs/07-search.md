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

## Done when
- The slice 4 targets, measured with `tools/bench` on the production search module at 4×:
  bytes per query ≤ 150 / 280 / 480 KB, slowest keystroke ≤ 50 / 80 / 250 ms (plus
  rendering, reported), at most 3% of queries over 100 ms.
- e2e tests: find by name, keyboard flow, copy, esc, about, LEI with good and bad check
  digits, open record, dark mode. axe reports no violations in either theme.
- Live on workers.dev against the published index (after slice 6). Screenshots.
