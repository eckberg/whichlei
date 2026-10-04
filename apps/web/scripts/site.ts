// Build settings that are worth a test: the index origin, the canonical origin and the CSP.

/** Fathom's host (DESIGN.md decision 23): its script, its page-view image and its beacons. */
export const FATHOM_ORIGIN = "https://cdn.usefathom.com";

function originOf(name: string, value: string | undefined): string {
  const text = (value ?? "").trim();
  if (text === "") return "";
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL, not ${text}`);
  }
  return url.origin;
}

/** The index origin as an origin (no path, no trailing slash), or "" when there is none. */
export const indexOrigin = (value: string | undefined): string => originOf("INDEX_ORIGIN", value);

/**
 * CANONICAL_ORIGIN as `wrangler.jsonc` sets it, the one place it is set, or "" before launch.
 * The file is JSONC with comments, so the variable is read by name, as the tests read it.
 */
export function canonicalOrigin(wranglerJsonc: string): string {
  const value = /"CANONICAL_ORIGIN"\s*:\s*"([^"]*)"/.exec(wranglerJsonc)?.[1];
  if (value === undefined) throw new Error("CANONICAL_ORIGIN is missing from wrangler.jsonc");
  return originOf("CANONICAL_ORIGIN", value);
}

/** An attribute value as plain text: the five escapes of HTML undone. */
function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * The search page for the canonical host. It adds the canonical link (the apex, so a preview
 * host's copy points at the page that may be indexed), the link to the OpenSearch description,
 * the Open Graph and Twitter tags that make a shared link a card, and the JSON-LD that names
 * the site. Title and description are read from the page, the one place they are written.
 * Nothing is added before launch, when there is no apex.
 */
export function searchPage(html: string, canonical: string): string {
  if (canonical === "") return html;
  const marker = "</title>\n";
  if (!html.includes(marker)) throw new Error("index.html has no <title> line to follow");
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
  if (!title || !description) throw new Error("index.html has no title or description to share");
  const tag = (attribute: string, name: string, content: string) =>
    `<meta ${attribute}="${name}" content="${content}">`;
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "whichlei",
    url: `${canonical}/`,
    description: unescapeHtml(description),
  };
  const head = [
    `<link rel="canonical" href="${canonical}/">`,
    // The file is written by build.ts under the same condition as these tags.
    '<link rel="search" type="application/opensearchdescription+xml" title="whichlei" href="/opensearch.xml">',
    tag("property", "og:type", "website"),
    tag("property", "og:site_name", "whichlei"),
    tag("property", "og:title", title),
    tag("property", "og:description", description),
    tag("property", "og:url", `${canonical}/`),
    tag("property", "og:image", `${canonical}/icon-512.png`),
    tag("name", "twitter:card", "summary"),
    // A data block, not run: the CSP's script-src does not apply. `<` is escaped so the
    // text can never close the tag.
    `<script type="application/ld+json">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`,
  ];
  return html.replace(marker, `${marker}${head.join("\n")}\n`);
}

/** sitemap.xml: the two pages that are not records (DESIGN.md decision 32). */
export function sitemap(canonical: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${canonical}/</loc></url>
<url><loc>${canonical}/about</loc></url>
</urlset>
`;
}

/**
 * opensearch.xml: lets a browser add whichlei as a search engine. The text goes after the
 * fragment (`/#q=`), which the page reads and removes; the browser fills the term in.
 */
export function openSearch(canonical: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>whichlei</ShortName>
<Description>Find an LEI by name, ISIN, BIC or register number</Description>
<InputEncoding>UTF-8</InputEncoding>
<Image width="16" height="16" type="image/x-icon">${canonical}/favicon.ico</Image>
<Url type="text/html" method="get" template="${canonical}/#q={searchTerms}"/>
</OpenSearchDescription>
`;
}

/** llms.txt: what the site is and where its records and search are, for a model that reads it. */
export function llmsTxt(canonical: string): string {
  return `# whichlei

> Find the Legal Entity Identifier (LEI) of a company, fund or public body by name, LEI, ISIN, BIC or national register number. Every record comes from GLEIF, the Global Legal Entity Identifier Foundation, under CC0. whichlei is not affiliated with GLEIF.

## Records

- \`<origin>/lei/<LEI>\`: one record as an HTML page, readable without JavaScript. Fetched live from the GLEIF API, with its source and golden copy date.
- \`<origin>/lei/<LEI>.json\`: the same record as JSON.
- \`<origin>/lei/<LEI>.md\`: the same record as Markdown.
- The HTML address also answers \`Accept: application/json\` and \`Accept: text/markdown\`.

An LEI has 20 characters. The last two are check digits (ISO 7064 mod 97-10); an LEI whose check digits do not match answers 404 without a lookup.

## Search

Name search runs in the browser, on a static index rebuilt daily from GLEIF's golden copy. There is no search API here. To open the search with text filled in: \`<origin>/#q=<text>\`.

Without a browser, search GLEIF directly:

- Names: \`https://api.gleif.org/api/v1/autocompletions?field=fulltext&q=<text>\`
- Exact legal name: \`https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=<name>\`
- ISIN: \`https://api.gleif.org/api/v1/lei-records?filter[isin]=<ISIN>\`
- BIC: \`https://api.gleif.org/api/v1/lei-records?filter[bic]=<BIC>\`
- Register number: \`https://api.gleif.org/api/v1/lei-records?filter[entity.registeredAs]=<number>\`

## Bulk data

Please do not crawl \`/lei/\` for bulk data. Every record is in GLEIF's golden copy, free under CC0: https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy/

## More

- About: <origin>/about
- Source code: https://github.com/eckberg/whichlei
`.replaceAll("<origin>", canonical);
}

/** The policy of /favicon.svg: nothing may load, and its own inline style may apply. */
export const FAVICON_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * The Content-Security-Policy of the search page: the site, the index, the GLEIF API and
 * Fathom. The same on every host (`_headers` cannot vary by host); the loader keeps Fathom
 * off any host but the canonical one.
 */
export function pageCsp(origin: string): string {
  return [
    "default-src 'self'",
    `connect-src ${["'self'", origin, "https://api.gleif.org", FATHOM_ORIGIN].filter(Boolean).join(" ")}`,
    `script-src 'self' ${FATHOM_ORIGIN}`,
    "worker-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    `img-src 'self' data: ${FATHOM_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The `_headers` file for static files: the site-wide headers, and for `/favicon.svg` a CSP
 * of its own. The site's `style-src 'self'` would block the SVG's inline `<style>` (its dark
 * colours), and the favicon is a file with no script that nothing else loads from.
 * Cloudflare applies every matching rule in order; `! Name` removes what an earlier rule set
 * (and runs before the rule's own headers), so the favicon gets this policy alone, not the
 * two joined with a comma.
 * https://developers.cloudflare.com/workers/static-assets/headers/
 */
export function headersFile(indexOrigin: string): string {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: interest-cohort=()
  Content-Security-Policy: ${pageCsp(indexOrigin)}

/favicon.svg
  ! Content-Security-Policy
  Content-Security-Policy: ${FAVICON_CSP}
`;
}
