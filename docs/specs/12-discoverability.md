# 12 · Search engines and agents

Status: approved by the owner in chat, 2026-10-01. Built; deploy waits for the owner.

## Goal
Search engines and AI agents can find whichlei, tell what it is, and read a record in a form
they can use, without spending more of the 100,000 Worker requests a day than people do.

## Scope
- **Favicon** (decision 33): "LEI" on a reverse-video tile, the I in the accent blue, drawn on
  the 16-unit grid. `favicon.svg` follows the browser theme; `favicon.ico` (16, 32, 48),
  `apple-touch-icon.png` (180) and `icon-512.png` are rendered from it by
  `pnpm --filter @whichlei/web favicon` and committed. Linked from every page.
- **Search page:** a title and description that say what it does, Open Graph tags, WebSite
  JSON-LD, an OpenSearch description. The about control is a link to `/about`; a plain click
  still opens the in-page view.
- **`/about`** (decision 38): the same man page, as a static file. No script.
- **`/#q=<text>`** (decision 37): opens the search with the text in the box.
- **Static files:** `sitemap.xml` with `/` and `/about` only (decision 32), `llms.txt`,
  `opensearch.xml`. Written only when `CANONICAL_ORIGIN` is set.
- **robots.txt** (decision 34): open to search crawlers and agents, training crawlers kept off
  `/lei/`, `Content-Signal: search=yes, ai-input=yes, ai-train=no`, the sitemap.
- **Record pages:** the name in the `<h1>` with the LEI; Open Graph tags; JSON-LD with
  `parentOrganization` and `identifier` (BIC, register number); parents and successors named
  (decision 36).
- **JSON and Markdown** (decision 35): `/lei/<LEI>.json`, `/lei/<LEI>.md`, and `Accept`
  negotiation on `/lei/<LEI>`. One cached record document serves all three (decision 18).

## Not in scope
- Record pages in the sitemap, IndexNow, link hubs: wait for four weeks of crawl numbers
  (decision 32).
- A search API, an MCP server, WebMCP: name search stays in the browser.
- `<link rel="alternate">` to the JSON and Markdown: it would invite crawlers to fetch three
  URLs per record. `llms.txt` documents them instead.
- Names of managing LOUs: every record has one, so naming it would double the GLEIF calls for
  every record. Later, from the index's `codes.json`.

## Approach
Everything new on the static side is a static file: free requests. The Worker work is on
paths it already serves. Reviewed by a separate agent; its findings that were taken: no
alternate links, `noindex` only on the `.json`/`.md` URLs (a negotiated answer is the
canonical URL), Google-Extended off the training list (it also covers Gemini grounding, and
crawls nothing itself), the content signal repeated for the training group, and the
OpenSearch link only with a canonical origin.

`/favicon.svg` carries an inline `<style>` for the dark theme. `_headers` detaches the site CSP
for that one path (`! Content-Security-Policy`) and sets `default-src 'none'; style-src
'unsafe-inline'`; checked with `wrangler dev`: one policy on the SVG, the site policy elsewhere.

## Unknowns
- **Crawler draw** of the names call: a cache miss for a record with a parent or an unnamed
  successor costs a second GLEIF call. Watch 503s in Workers analytics after deploy.
- **Owner steps,** dashboard only:
  - Google Search Console and Bing Webmaster Tools for whichlei.com (a DNS TXT record each).
    Their crawl stats are the numbers decision 32 waits for.
  - Optional: Cloudflare Security → Bots → "Block AI bots". It acts on user agents, before the
    Worker. Afterwards the live check must still find no cookie.

## Measured
- Rendering, p99 per page (`pnpm --filter @whichlei/web bench`): HTML 0.06–0.25 ms (before
  0.05–0.21), parsing GLEIF's JSON and rendering 0.32–0.52 ms (before 0.26–0.41), Markdown
  0.05–0.14 ms, JSON ≤ 0.012 ms, a cache hit 0.13–0.29 ms. Limit 10 ms.
- Worker bundle, minified: 20.4 KB → 28.2 KB.
- Icons: `favicon.svg` 384 B, `favicon.ico` 1,347 B, `apple-touch-icon.png` 813 B,
  `icon-512.png` 2,003 B.

## Done when
- Unit tests and e2e pass: robots on and off the canonical host; record head, h1, JSON-LD,
  names (one call, none when nothing to name, degraded on failure); `.json`/`.md`, redirects,
  404/503 per format, negotiation with q-values, `Vary`, noindex; one cache entry for all
  formats, old entries ignored; `/#q=`; `/about` (no script, one h1, axe clean); icons,
  sitemap, `llms.txt`, OpenSearch; the favicon's colours in light and dark.
- After the owner's deploy, on whichlei.com: `curl` robots.txt, `/sitemap.xml`, `/llms.txt`,
  `/favicon.ico`, `/about`, `/lei/549300W9JLPW15XIFM52.json` and `.md`; the live check passes
  (no cookie, Fathom sees `/` and `/lei/` only).
