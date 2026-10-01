// Build settings that are worth a test: the index origin and the CSP made from it.

/** The index origin as an origin (no path, no trailing slash), or "" when there is none. */
export function indexOrigin(value: string | undefined): string {
  const text = (value ?? "").trim();
  if (text === "") return "";
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`INDEX_ORIGIN must be an http(s) URL, not ${text}`);
  }
  return url.origin;
}

/** The Content-Security-Policy of the search page: the site, the index and the GLEIF API. */
export function pageCsp(origin: string): string {
  return [
    "default-src 'self'",
    `connect-src ${["'self'", origin, "https://api.gleif.org"].filter(Boolean).join(" ")}`,
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
