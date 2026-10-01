# 11 · Launch

Status: approved

## Goal
whichlei is live on https://whichlei.com. Search engines may index it there and only
there. Fathom counts page views and searches without cookies and without ever seeing what
was typed. The README and the about page say what the site is, where the data comes from
and what is counted. No cookie is set, shown in a browser against the live site.

## Scope
- **Hosts** (Workers Custom Domains, `routes: [{ pattern, custom_domain: true }]` in
  `wrangler.jsonc`; each creates its own DNS record and certificate):
  - `whichlei.com` → `whichlei-site`. `workers_dev` stays on as the preview and e2e target.
  - `www.whichlei.com` → new `whichlei-redirect` (`apps/redirect`): 301 to
    `https://whichlei.com` with path and query kept. Deployed by `deploy-site.yml`.
  - `index.whichlei.com` → `whichlei-index`. `workers_dev` stays on; CORS is already `*`.
- **Indexing:** `ALLOW_INDEXING` `"true"`, `CANONICAL_ORIGIN` `"https://whichlei.com"`
  (decision 17). The search page gets a canonical link to the apex. The build reads
  `CANONICAL_ORIGIN` from `apps/web/wrangler.jsonc`, so there is one source.
- **Analytics:** a built static loader, `/scripts/stats.js`, on the search page and on
  record pages (200 only). It does nothing unless `location.origin` is `CANONICAL_ORIGIN`.
  On the apex it strips the query string (`history.replaceState`), adds Fathom's script
  with `data-site="IWPQIWKG"`, `data-auto="false"`, `data-included-domains="whichlei.com"`,
  and sends one page view: `/` for the search page, `/lei/` for every record page.
- **Search count:** one Fathom event, `search`, per settled query (decision 31).
- **CSP** (decision 23 amended): add `https://cdn.usefathom.com` to `script-src`, `img-src`
  and `connect-src`, in the static `_headers` and in the Worker's record-page CSP. The same
  policy on every host: `_headers` cannot vary by host, and the loader is what keeps
  Fathom off other hosts.
- **Workflows:** `deploy-site.yml` builds with `INDEX_ORIGIN=https://index.whichlei.com`,
  deploys `whichlei-redirect` too, names its environment `production` with the apex URL,
  and after the workers.dev e2e runs the live check against the apex. `publish-index.yml`
  and `rollback-index.yml` switch `INDEX_ORIGIN` to `https://index.whichlei.com`.
- **Zone settings** (owner, dashboard, or the API if the token allows): Always Use HTTPS
  on (now off), minimum TLS 1.2 (now 1.0), Bot Fight Mode off, Cloudflare Web Analytics
  off. **Fathom** (owner): site firewall "Allowed domains" = `whichlei.com`.
- **README:** what it is and the live link; data from GLEIF under CC0 with a link to the
  golden copy; not affiliated with GLEIF; how to develop (install, `pnpm dev`, lint,
  typecheck, test, e2e); links to DESIGN.md, PLAN.md, `research/ranking`; MIT for the code.
- **About page.** It already says: data from GLEIF, CC0, rebuilt daily, records live from
  the API, the golden copy date and entity count, no account, no cookies, analytics never
  see what you type. Add: analytics are Fathom, which gets the page (`/` or `/lei/`, never
  the LEI), the referring site, and a count of searches without their text; source code and
  issues on GitHub; not affiliated with GLEIF.

## Not in scope
- **Sitemaps** (deferred here by slices 6 and 9): not at launch, decision 32.
- HSTS and preload: hard to undo; later, once the hosts are settled.
- Proxying Fathom through our own host, SRI on Fathom's script (Fathom updates it in place;
  the copy fetched 2026-10-01 has `cache-control: max-age=0`).
- Uptime monitoring, Workers Paid, any other paid plan.

## Approach
Order, so nothing points at a host that does not answer yet:
1. One PR with the code: loader, search counter, CSP, `apps/redirect`, the index route,
   README, about page, tests. The site's `INDEX_ORIGIN` stays on workers.dev.
2. A publish-index run by hand attaches `index.whichlei.com`. Check it serves `index.json`.
3. A second PR switches every `INDEX_ORIGIN` to `index.whichlei.com` and adds the apex
   route and the indexing variables. Owner approves the deploy (CLAUDE.md: ask first).
4. Owner sets the zone and Fathom settings. Then the live check.

Custom domains need no DNS or ruleset API calls, which this token cannot make. If attaching
fails for permissions, the deploy stops and the owner adds **Zone → Workers Routes → Edit**
for `whichlei.com` to the token (the API docs list only Account → Workers Scripts → Edit,
which the token has). If it fails because a DNS record already exists on the hostname, the
owner deletes that record in the dashboard; the token cannot list DNS records.

Rollback: set `ALLOW_INDEXING` to `"false"` and redeploy; a custom domain is detached in
the dashboard. The workers.dev hosts keep working throughout.

**Fathom's script**, read 2026-10-01 (`cdn.usefathom.com/script.js`, last modified
2026-08-20). The page view is an `<img>` to `https://cdn.usefathom.com/?h=&p=&r=&sid=&qs=`,
events and the leave ping use `navigator.sendBeacon` to the same host: hence `img-src` and
`connect-src`. It honours `data-included-domains` (no longer in the docs, which point to
the firewall setting; we use both). It always sends these query parameters if present:
`q`, `s`, `keyword`, `name`, `ref`, `action`, `pagename`, `tab`, `via`, `utm_*`, `gclid`,
`msclkid`, read from `location.search` even when a `url` is passed. The page never puts
the search in the URL, but anyone can link `/?q=…`; so the loader strips the query first. It sets no cookie; it reads
`localStorage.blockFathomTracking` and writes it only when the visitor asks.

**Search counter**, `src/page/stats.ts`, a pure module with an injected clock. Off the input
path: it is told after a results frame renders, schedules with `setTimeout`, sends from
`requestIdleCallback` (else `setTimeout(0)`), calls `window.fathom?.trackEvent?.("search")`
in `try`/`catch`. Where Fathom is not loaded it does nothing.

## Proposed decisions
For the DESIGN.md table.

| # | Decision | Why |
|---|----------|-----|
| 27 | **whichlei.com is the only canonical host**, a Workers Custom Domain on `whichlei-site`. workers.dev stays up as the preview and is never indexed | A custom domain creates its own DNS record and certificate, so no DNS or ruleset permission is needed. The Cache API starts working (decision 18). |
| 28 | **www.whichlei.com is a separate Worker, `whichlei-redirect`**, that answers 301 to the apex with path and query | A Redirect Rule needs a proxied DNS record for www and ruleset permission, which the token lacks. Adding www to `whichlei-site` would not redirect static paths (only `/lei/*` runs the Worker), and running the Worker on every path spends the free plan's 100,000 requests a day. www traffic is small. |
| 29 | **The index is served from index.whichlei.com**; its workers.dev host stays | The site no longer depends on the account's personal workers.dev subdomain, which can be renamed. CORS is already `*`, so previews keep working. No cost. |
| 30 | **Fathom loads only on whichlei.com and sees `/` or `/lei/`, never an LEI or a query string** | Which record someone opened is close to what they searched for (decision 12). Per-LEI counts are not needed. Fathom's script sends `q` and similar parameters on its own, so the query string goes before it loads. |
| 31 | **One `search` event per settled query.** A query settles when its results are on screen and the input has not changed for 2 s, or earlier when the user copies an LEI or opens a record. A query text counts once per page load; the text is held in memory only. Nothing about the query is sent: no text, length, type or hit count | Counts searches, not keystrokes. Copy and open end a search, often within 2 s ("copy it and leave"), so they count at once. 2 s is far above the 150 ms debounce and a normal pause between keys. "Name" against "identifier" would describe the input; one event keeps decision 12 checkable. |
| 32 | **No sitemap at launch** | A sitemap offers 3.4M record pages to crawlers; each is a Worker request against 100,000 a day, shared with every other Worker on the account. Measure what crawlers take by links alone for four weeks, then decide. |
| 23 | *Amended:* the CSP also allows `https://cdn.usefathom.com` for script, image and connect | Fathom's script, its page-view image and its beacons. |

## Unknowns
- **Token permission for custom domains.** Found by the first deploy; fallback above.
- **Fathom usage.** Fathom bills events with page views. Searches could double or triple the
  count. Owner confirms the plan has room (recurring cost: ask first).
- **Cookies from Cloudflare.** Bot Fight Mode or a challenge can set `__cf_bm` or
  `cf_clearance`; this token cannot read bot settings. The live check catches it.
- **Whether Playwright can intercept `sendBeacon`.** If yes, the live check answers Fathom's
  requests itself and nothing is counted. If not, it lets them through: a few views per
  deploy.
- **Crawler draw** on the 100,000 a day (slice 9). Watched in Workers analytics after launch.

## Done when
Each with its evidence in the PR or this spec.
- `curl -sI`: `https://whichlei.com/` 200; `http://whichlei.com/` 301 to https;
  `https://www.whichlei.com/lei/<LEI>?x=1` 301 to `https://whichlei.com/lei/<LEI>?x=1`;
  `https://index.whichlei.com/index.json` 200 with `access-control-allow-origin: *`.
- `robots.txt`: `Allow: /` on the apex, `Disallow: /` on workers.dev.
- A record page on the apex: `<link rel="canonical" href="https://whichlei.com/lei/…">` and no
  `x-robots-tag`; on workers.dev: `x-robots-tag: noindex`, canonical still the apex.
- Cache API: the same LEI twice on the apex, `x-cache: MISS` then `HIT`, with both times.
- `publish-index.yml` passes `verify-live` against `index.whichlei.com`. Link to run.
- **Live check** (`e2e/live.spec.ts`, runs only with `LIVE_URL`), against the apex: search
  "ericsson", wait for the event, copy, open the record, back, open about. Then:
  `context.cookies()` empty; `document.cookie` empty on each page; no `set-cookie` in any
  response, any host; no CSP violation in the console. Fathom: one page view with
  `sid=IWPQIWKG` and `p=/`, one with `p=/lei/`; exactly one `search` event; no request to
  Fathom contains "ericsson" or the LEI. Link to run.
- The regular e2e (localhost and workers.dev) makes no request to `cdn.usefathom.com`;
  asserted, and blocked in the Playwright config as well.
- Unit tests: the counter (keys within 2 s send nothing; a settled query sends one; copy
  before 2 s sends one and nothing after; the same text again sends nothing), the loader
  (host check, `/lei/` collapse, query stripped).
- Slice 7's key-to-next-paint (32 / 48 / 120 ms) with the counter on and a stub
  `window.fathom`: within the spread of two baseline runs in the same session.
- Owner: a Fathom dashboard screenshot with views on `/` and `/lei/` and a `search` event.
- README and about page merged; DESIGN.md decisions 27–32 and 23 updated.
