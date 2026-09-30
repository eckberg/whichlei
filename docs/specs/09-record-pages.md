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
- Until launch, the workers.dev host is not indexed: `robots.txt` (served by the Worker)
  disallows and pages send `X-Robots-Tag: noindex`. One setting, `ALLOW_INDEXING` in
  `wrangler.jsonc`, turns indexing on at launch. `CANONICAL_ORIGIN` sets the origin of the
  canonical link.

## Not in scope
- Sitemaps: they need the LEI list, so slice 6 publishes them with the index.
- Fetching parent names: one GLEIF request per page. Parents show as linked LEIs.

## Approach
A small `fetch` handler in `apps/web/src/worker.ts`, rendering an HTML string. The renderer
is a pure function of `LeiRecord` so the search page's record view (slice 8) can reuse it.
Escape every value. No framework.

## Unknowns
- **CPU per request** (measured, `pnpm --filter @whichlei/web bench`: every recorded fixture,
  1,000 runs, Node on a server CPU). Rendering a page: median 0.012 to 0.016 ms, p99 at most
  0.30 ms. Reading GLEIF's JSON into a record as well (the cost of a cache miss): p99 at
  most 0.52 ms. A page is about 3.5 KB of HTML. The limit is 10 ms, so there is a factor of
  about 20. Waiting for GLEIF is not CPU time. The Worker bundle is 29 KB. Not measured in
  the Workers runtime itself: check the CPU time in the Cloudflare dashboard after deploy.
- **Worker requests a day** (estimate, no traffic data yet). Only `/lei/*` and
  `/robots.txt` reach the Worker; the page's stylesheet and script are free static requests.
  A cache hit still counts as a request: the cache saves GLEIF calls and CPU, not requests.
  A redirect counts too. Who sends them:
  - Before launch: nothing links here and robots.txt disallows everything. A few hundred a
    day at most, from us and testers.
  - People: search stays in the browser and opens records from GLEIF directly (slice 8), so
    only shared permalinks reach the Worker. Guess: 1,000 to 3,000 a day after launch.
  - Crawlers: the real unknown. There is no sitemap until slice 6, and pages link only to
    parents and successors, so discovery is slow. Polite search crawlers: perhaps 1,000 to
    10,000 a day at first, growing with demand. One aggressive or AI crawler can pass
    100,000 on its own, and nothing here limits it.
  - So the first months should stay under 100,000, without margin against a crawler.
  Past the limit, requests that match `run_worker_first` get a 429 instead of falling back to
  static files (Cloudflare docs, static assets billing). `/lei/*` and `/robots.txt` fail
  until midnight UTC; the search page and index stay up. A 429 on robots.txt makes crawlers
  back off, which is the useful failure. Options if it happens: stay on noindex, or Workers
  Paid ($5 a month), which DESIGN.md non-goals rule out without a decision.
- **Cache API needs a custom domain.** On `*.workers.dev` the Cache API does nothing, so
  there every view calls GLEIF (about 0.5 s, and GLEIF's per-IP limit of about 60 a minute
  applies to Cloudflare's shared addresses). Caching starts working on whichlei.com. The
  live check on workers.dev covers the page, headers and failure path, not cache hits.

## Done when
- Tests: canonical redirects, 404 for bad and unknown LEIs, 503 on GLEIF failure, cache
  headers, escaping of hostile names, and the page for each recorded fixture.
- Rendering CPU time per page, measured. Under 10 ms at p99.
- A live page on workers.dev, fetched with `curl` (no JavaScript) and in a browser.
