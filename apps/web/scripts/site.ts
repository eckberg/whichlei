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
 * CANONICAL_ORIGIN as `wrangler.jsonc` sets it, the one place it is set, or "" when it is empty.
 * The file is JSONC with comments, so the variable is read by name, as the tests read it.
 */
export function canonicalOrigin(wranglerJsonc: string): string {
  const value = /"CANONICAL_ORIGIN"\s*:\s*"([^"]*)"/.exec(wranglerJsonc)?.[1];
  if (value === undefined) throw new Error("CANONICAL_ORIGIN is missing from wrangler.jsonc");
  return originOf("CANONICAL_ORIGIN", value);
}

/**
 * The search page with its canonical link: the apex, so a preview host's copy points at the
 * page that may be indexed. No link when the setting is empty, as there is no apex.
 */
export function searchPage(html: string, canonical: string): string {
  if (canonical === "") return html;
  const marker = "</title>\n";
  if (!html.includes(marker)) throw new Error("index.html has no <title> line to follow");
  return html.replace(marker, `${marker}<link rel="canonical" href="${canonical}/">\n`);
}

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
