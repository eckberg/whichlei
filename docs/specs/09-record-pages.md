# 09 · Record pages

Status: approved

## Goal
Every LEI has a page, `/lei/<code>`, that a person can read without JavaScript, a link can
point to, and a search engine could index. It shows the live GLEIF record with its source
and date, and copies the LEI.

## Scope
- The site Worker gains a script that answers `/lei/*` only; every other path stays a free
  static request (`run_worker_first`).
- `/lei/<code>`: lower case or spaces redirect (301) to the canonical upper-case URL; bad
  check digits answer 404 without calling GLEIF; an unknown LEI answers 404; a GLEIF failure
  answers 503 with `Retry-After`, never cached.
- The page: the record fields from `packages/gleif`, parents and successors as links to
  their own pages, source link and golden copy date, a copy button (works without JS as
  selectable text). Terminal style from the prototype. `<title>`, description, canonical
  link, and JSON-LD `Organization` with `leiCode`.
- Caching with the Cache API: a record until shortly after GLEIF's next daily publish
  (about 08:00 UTC), a 404 for an hour. Browsers may keep a page for an hour.
- Until launch, the workers.dev host is not indexed: `robots.txt` disallows and pages send
  `X-Robots-Tag: noindex`. One setting turns indexing on at launch.

## Not in scope
- Sitemaps: they need the LEI list, so slice 6 publishes them with the index.
- Fetching parent names: one GLEIF request per page. Parents show as linked LEIs.

## Approach
A small `fetch` handler in `apps/web/src/worker.ts`, rendering an HTML string. The renderer
is a pure function of `LeiRecord` so the search page's record view (slice 8) can reuse it.
Escape every value. No framework.

## Unknowns
- CPU time per request against the free plan's 10 ms limit: measured on the rendering of
  the recorded fixtures.
- The draw on the free plan's 100,000 Worker requests a day: every `/lei/*` view counts,
  cached or not. GLEIF requests only on a cache miss. Estimated from the numbers above and
  written here.

## Done when
- Tests: canonical redirects, 404 for bad and unknown LEIs, 503 on GLEIF failure, cache
  headers, escaping of hostile names, and the page for each recorded fixture.
- Rendering CPU time per page, measured. Under 10 ms at p99.
- A live page on workers.dev, fetched with `curl` (no JavaScript) and in a browser.
