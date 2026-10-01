# 11 · Launch

Status: done, except the owner's Fathom dashboard check (below)

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
0. Before the first deploy, the owner checks the DNS records of `www`, `index` and the apex
   in the dashboard (below).
1. One PR with the code: loader, search counter, CSP, `apps/redirect`, README, about page,
   tests. The site's `INDEX_ORIGIN` stays on workers.dev. The index route is **not** in it:
   the nightly publish (02:47 UTC) would attach the host unverified, and `wrangler deploy`
   makes the version live before it attaches domains, so a failed attach leaves an unchecked
   index live.
2. A small PR adds the `index.whichlei.com` route to `apps/index/wrangler.jsonc`, merged right
   before a publish-index run by hand, which attaches it. Check it serves `index.json`.
3. A second PR switches every `INDEX_ORIGIN` to `index.whichlei.com` and adds the apex
   route and the indexing variables. Owner approves the deploy (CLAUDE.md: ask first).
4. Owner sets the zone and Fathom settings. Then the live check.

Custom domains need no DNS or ruleset API calls, which this token cannot make. If attaching
fails for permissions, the deploy stops and the owner adds **Zone → Workers Routes → Edit**
for `whichlei.com` to the token (the API docs list only Account → Workers Scripts → Edit,
which the token has).

**Existing DNS records are replaced, not refused.** In CI (no terminal) wrangler sets
`override_existing_dns_record` and `override_existing_origin` to true for a custom domain, so a
record already on `www`, `index` or the apex is overwritten silently. The token cannot list DNS
records, so the owner looks in the dashboard (DNS → Records) **before the first deploy** for
each of the three hostnames, and deletes or keeps each knowingly (mail, verification or an old
site on it). Nothing else in the zone is touched.

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
| 30 | **Fathom loads only on whichlei.com and sees `/` or `/lei/`, never an LEI or a query string, and only the origin of the referring site** | Which record someone opened is close to what they searched for (decision 12). Per-LEI counts are not needed. Fathom's script sends `q` and similar parameters on its own, so the query string goes before it loads. It also sends `document.referrer` whole, and another site's address can carry its own query, so the referrer is cut to its origin first. |
| 31 | **One `search` event per settled query.** A query settles when its results are on screen and the input has not changed for 2 s, or earlier when the user copies an LEI or opens a record. A query text counts once per page load, ignoring case and spacing; the text is held in memory only. Only results that were found or found nothing count, not an error, a too short input or a bad LEI. Nothing about the query is sent: no text, length, type or hit count | Counts searches, not keystrokes. Copy and open end a search, often within 2 s ("copy it and leave"), so they count at once. 2 s is far above the 150 ms debounce and a normal pause between keys. "Name" against "identifier" would describe the input; one event keeps decision 12 checkable. |
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

## Measured (step 1)
**Key to next paint with the counter** (`pnpm --filter @whichlei/bench run search --skip bytes,timing
--modes every --page-every 32 --stats on|off --settle-ms 2100`; the built page, 4x, real key
presses, 101 queries, 1,485 keys; slowest per query, median / p90 / max, ms). `off` builds
the page without the counter, `on` has it and a stub `window.fathom` that counted 101 events
for 101 queries. One locked session of six runs, order off, on, off, on, then on, off
(`--page-every 32`, not 16, to keep the lock to 13 minutes a run):

| Run | 1 | 2 | 3 (reversed) |
|---|---|---|---|
| Counter off | 24 / 56 / 72 | 24 / 48 / 120 | 32 / 56 / 152 |
| Counter on | 32 / 48 / 80 | 32 / 56 / 96 | 32 / 56 / 144 |

The counter is within the spread of the baselines (24-32 / 48-56 / 72-152). The host got
slower during the session: every number rose from run 1 to run 3, counter on or off. The
first two pairs, off before on, alone put the median 8 ms (one 16 ms frame step) over the
baselines; with run 3 the same on both sides, the counter's cost is not resolvable at frame
granularity (16 ms steps). Key to first results, median:
off 120 / 126 / 137, on 130 / 141 / 142 ms.
The counter does one `setTimeout` and one `clearTimeout` a render and a short string
normalisation; it sends once, 2 s after the results, from an idle callback.

**Fathom's beacons in Playwright** (a dry run of `e2e/live.spec.ts` against a local site made
canonical, with Fathom's script served from a copy): page-view images and the `search` event
were answered by the check's route and never left the machine; the leave ping that Fathom sends
on `pagehide` (`dp=1`) was not intercepted. So a live check counts no views and no search,
but a visit's leave pings (duration, no path beyond `/` or `/lei/`) can reach Fathom. Going back
reloads the search page in Playwright (no back/forward cache), so the check expects one `/` view
for each load of the search page, not one in all.

## Deviations from the first draft
- The `index.whichlei.com` route moved out of this PR (step 2 above), after review: see step 1.
  `publish-index.yml`'s summary now asks Cloudflare which version is live before it says
  anything after a failed deploy.
- The loader trims the referrer to its origin (Fathom sends `document.referrer` whole on page
  views and events), by overriding `document.referrer` and passing `referrer` to the page view.
- The `www` custom domain is in `apps/redirect/wrangler.jsonc` in the code PR (step 1):
  nothing points at it, and step 3 lists only the apex. The deploy workflow deploys the
  redirect Worker after the e2e run; its environment name, `INDEX_ORIGIN` and the live-check
  step wait for step 3, when the apex answers.
- The loader's source is `src/page/stats-loader.ts` and `stats-entry.ts`, built to
  `/scripts/stats.js`; the pageview URL is passed as a path (`/`, `/lei/`) and Fathom resolves it.
- A search counts when its results are `done` or `no-match`: an error, a too short input and a
  bad LEI do not. Case and spacing do not make a new query text.
- Playwright blocks Fathom with `--host-resolver-rules` in the browser launch arguments (the
  config cannot route requests); `LIVE_URL` removes the block and points the config at that site.

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

## Result (2026-10-01)
Live on https://whichlei.com. Deploy run 36872209597 is green, including the live check
against the apex: no cookie in the jar or on the wire from our hosts or Fathom, no CSP
violation, a record page with names (`max-age=3600`, "Aktiebolag"), Fathom page views on `/`
and `/lei/`, and one `search` event.

| Check | Result |
|---|---|
| `https://whichlei.com/` | 200 |
| `http://whichlei.com/` | 301 to `https://whichlei.com/` |
| `https://www.whichlei.com/lei/549300W9JLPW15XIFM52?x=1` | 301 to `https://whichlei.com/lei/549300W9JLPW15XIFM52?x=1` |
| `https://index.whichlei.com/index.json` | 200, `access-control-allow-origin: *` |
| `robots.txt` | `Allow: /` on the apex, `Disallow: /` on workers.dev |
| Record page canonical | `https://whichlei.com/lei/…` on both hosts; workers.dev also sends `x-robots-tag: noindex` |
| Cache API on the apex | the same LEI twice: `x-cache: MISS`, then `HIT` |

What the first live runs caught, and what changed:
- GLEIF's load balancer sends `Set-Cookie` on lookups. The browser stored nothing; the page now
  fetches GLEIF and the index with `credentials: "omit"` (PR #19).
- Cloudflare Web Analytics and RUM injected `static.cloudflareinsights.com/beacon.min.js` into
  every HTML page, for browsers only. The CSP blocked it. The owner turned both off in the
  dashboard; the live check fails if they come back.

Owner settings done: Always Use HTTPS, Web Analytics off (EU and non-EU), RUM off. Still to
confirm: minimum TLS 1.2, Bot Fight Mode off, Fathom allowed domains, and a Fathom dashboard
screenshot showing `/`, `/lei/` and a `search` event.
