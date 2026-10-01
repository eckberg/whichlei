// The site Worker. It answers `/lei/*` and `/robots.txt` only (`run_worker_first` in
// wrangler.jsonc); every other path is a static asset and costs nothing.
//
// /lei/<code>: redirect to the canonical form, reject bad check digits without calling GLEIF,
// then serve from the Cache API or fetch the record live and render it. See DESIGN.md
// decisions 2, 17 and 18.

import { isValidLei } from "@whichlei/core";
import { type Fetch, fetchRecord, GleifError } from "@whichlei/gleif";
import { type Codes, createCodesReader } from "./codes.ts";
import { renderMessagePage, renderRecordPage } from "./record.ts";
import { type CacheOutcome, cacheTtl, DEGRADED_TTL } from "./ttl.ts";

// The parts of the Workers runtime used here. Declared locally so no extra types package is
// needed, and so tests can fake them.
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  ASSETS: Fetcher;
  /**
   * `"true"` lets crawlers in, but only on the host named by CANONICAL_ORIGIN. Anything else
   * keeps the site out of search engines.
   */
  ALLOW_INDEXING?: string;
  /**
   * The site's own origin, such as `https://whichlei.com`. Canonical links, JSON-LD and
   * redirects point at it. Empty until launch: then they use the origin of the request, and
   * no host is indexable.
   */
  CANONICAL_ORIGIN?: string;
  /**
   * Where the published index is served from: the same value as INDEX_ORIGIN in deploy-site.yml.
   * Its `codes.json` gives names to legal form and registration authority codes. Empty or
   * unreachable: a record page shows the codes.
   */
  INDEX_ORIGIN?: string;
}

export interface Deps {
  /** The Cache API's default cache. Null where there is none: nothing is cached then. */
  cache(): CacheLike | null;
  /** Used for GLEIF and for the index host. */
  fetch: Fetch;
  now(): Date;
  /** How long to wait for GLEIF before answering 503. */
  gleifTimeoutMs: number;
  /** How long to wait for the index host (index.json, then codes.json). Defaults to 2000. */
  indexTimeoutMs?: number;
}

const BROWSER_MAX_AGE = 3600;
const REDIRECT_MAX_AGE = 86400;
const DEFAULT_RETRY_AFTER = 60;
const GLEIF_TIMEOUT_MS = 8000;

// Only the site itself: styles, fonts and the copy button script are static files. A record
// page fetches nothing, so nothing else is allowed.
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

interface Answer {
  status: number;
  body: string;
  contentType?: string;
  /** Cache-Control for the browser. */
  cacheControl: string;
  headers?: Record<string, string>;
}

function respond(request: Request, env: Env, answer: Answer): Response {
  const url = new URL(request.url);
  const headers = new Headers({
    "content-type": answer.contentType ?? "text/html; charset=utf-8",
    "cache-control": answer.cacheControl,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "interest-cohort=()",
    "content-security-policy": CSP,
    ...answer.headers,
  });
  if (!indexable(env, url)) headers.set("x-robots-tag", "noindex");
  return new Response(request.method === "HEAD" ? null : answer.body, {
    status: answer.status,
    headers,
  });
}

const publicFor = (seconds: number) => `public, max-age=${seconds}`;

function message(status: number, title: string, heading: string, detail: string, extra = {}) {
  return {
    status,
    body: renderMessagePage({ title, heading, detail }),
    cacheControl: publicFor(BROWSER_MAX_AGE),
    ...extra,
  };
}

/** The answer for a GLEIF failure. Never cached, by us or the browser. */
function unavailable(retryAfter: number | null): Answer {
  const seconds = Math.max(1, retryAfter ?? DEFAULT_RETRY_AFTER);
  return message(
    503,
    "Try again shortly",
    "Try again shortly",
    "GLEIF did not answer, or asked us to slow down. The record is not lost: reload in a minute.",
    { cacheControl: "no-store", headers: { "retry-after": String(seconds) } },
  );
}

/** CANONICAL_ORIGIN as an origin, or null when it is empty or not an http(s) URL. */
function configuredOrigin(env: Env): string | null {
  try {
    if (env.CANONICAL_ORIGIN) {
      const origin = new URL(env.CANONICAL_ORIGIN);
      if (origin.protocol === "https:" || origin.protocol === "http:") return origin.origin;
    }
  } catch {
    // Not a URL: treated as unset.
  }
  return null;
}

const canonicalOrigin = (env: Env, url: URL): string => configuredOrigin(env) ?? url.origin;

/**
 * Crawlers are let in only when the setting is on and the request came to the canonical
 * host. The workers.dev host is never indexed (DESIGN.md decision 17).
 */
const indexable = (env: Env, url: URL): boolean => {
  const canonical = configuredOrigin(env);
  return env.ALLOW_INDEXING === "true" && canonical !== null && canonical === url.origin;
};

const asciiUpper = (text: string) => text.replace(/[a-z]/g, (c) => c.toUpperCase());

/** What a request path says about the LEI it asks for. */
function readLeiPath(pathname: string): { lei: string; canonical: boolean } | null {
  let segment = pathname.slice("/lei/".length);
  const trailingSlash = segment.endsWith("/");
  if (trailingSlash) segment = segment.slice(0, -1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const lei = asciiUpper(decoded.replace(/\s+/g, ""));
  if (!/^[0-9A-Z]{20}$/.test(lei)) return null;
  return { lei, canonical: segment === lei && !trailingSlash };
}

/** Fetch and render a record. Anything but a record or an unknown LEI is a failure. */
async function lookup(
  lei: string,
  origin: string,
  deps: Deps,
  codes: () => Promise<Codes | null>,
  expectCodes: boolean,
): Promise<{
  answer: Answer;
  outcome: CacheOutcome;
  goldenCopyDate: string | null;
  degraded: boolean;
}> {
  try {
    const record = await fetchRecord(lei, {
      fetch: deps.fetch,
      signal: AbortSignal.timeout(deps.gleifTimeoutMs),
    });
    // A record for another LEI is an answer we cannot trust: never show or cache it.
    if (record.lei !== lei)
      throw new GleifError("failed", `GLEIF answered ${record.lei} for ${lei}`);
    // Only for a record that is going to be shown: an unknown LEI costs the index host nothing.
    // It never rejects: a page without names is still a page.
    const names = await codes();
    // Names that should have been there and were not: no browser keeps the page for an hour.
    const degraded = expectCodes && names === null;
    const answer = {
      status: 200,
      body: renderRecordPage(record, { canonicalOrigin: origin, codes: names }),
      cacheControl: publicFor(degraded ? DEGRADED_TTL : BROWSER_MAX_AGE),
    };
    return {
      answer,
      outcome: "found",
      goldenCopyDate: record.source.goldenCopyDate,
      // And do not keep it in the cache for a day either.
      degraded,
    };
  } catch (error) {
    if (error instanceof GleifError && error.kind === "not-found") {
      const answer = message(
        404,
        "No such LEI",
        "No such LEI",
        `GLEIF has no record for ${lei}. The code is well formed, but no entity has it.`,
      );
      return { answer, outcome: "not-found", goldenCopyDate: null, degraded: false };
    }
    const retryAfter = error instanceof GleifError ? error.retryAfter : null;
    return {
      answer: unavailable(retryAfter),
      outcome: "failure",
      goldenCopyDate: null,
      degraded: false,
    };
  }
}

async function fromCache(cache: CacheLike | null, key: Request): Promise<Answer | null> {
  if (cache === null) return null;
  try {
    const hit = await cache.match(key);
    if (hit === undefined) return null;
    // A browser never keeps a page longer than the cache does: a page stored for 5 minutes
    // (names missing) is kept by browsers for 5 minutes too.
    const stored = Number(/max-age=(\d+)/.exec(hit.headers.get("cache-control") ?? "")?.[1]);
    return {
      status: hit.status,
      body: await hit.text(),
      cacheControl: publicFor(
        Number.isFinite(stored) ? Math.min(BROWSER_MAX_AGE, stored) : BROWSER_MAX_AGE,
      ),
      headers: { "x-cache": "HIT" },
    };
  } catch {
    return null;
  }
}

function toCache(
  cache: CacheLike | null,
  key: Request,
  answer: Answer,
  outcome: CacheOutcome,
  goldenCopyDate: string | null,
  degraded: boolean,
  deps: Deps,
  ctx: ExecutionContext,
) {
  const full = cacheTtl(outcome, deps.now(), goldenCopyDate);
  const ttl = degraded ? Math.min(full, DEGRADED_TTL) : full;
  if (cache === null || ttl === 0) return;
  const stored = new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": publicFor(ttl) },
  });
  ctx.waitUntil(cache.put(key, stored).catch(() => {}));
}

async function serveLei(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: Deps,
  readCodes: (origin: string | undefined) => Promise<Codes | null>,
) {
  const url = new URL(request.url);
  const asked = readLeiPath(url.pathname);
  const origin = canonicalOrigin(env, url);
  if (asked === null) {
    return respond(
      request,
      env,
      message(
        404,
        "Not an LEI",
        "Not an LEI",
        "An LEI has 20 characters: letters and digits, the last two digits. Check what you typed.",
      ),
    );
  }
  if (!asked.canonical) {
    return respond(request, env, {
      status: 301,
      body: "",
      contentType: "text/plain; charset=utf-8",
      cacheControl: publicFor(REDIRECT_MAX_AGE),
      headers: { location: `${origin}/lei/${asked.lei}` },
    });
  }
  if (!isValidLei(asked.lei)) {
    return respond(
      request,
      env,
      message(
        404,
        "Not a valid LEI",
        "Not a valid LEI",
        `${asked.lei} is not an LEI: its check digits do not match (ISO 7064 mod 97-10). Check what you typed.`,
      ),
    );
  }

  // The key is the canonical URL: the query string, which a crawler can vary at will, is
  // not part of it.
  const key = new Request(`${origin}/lei/${asked.lei}`);
  const cache = deps.cache();
  const cached = await fromCache(cache, key);
  if (cached !== null) return respond(request, env, cached);

  const { answer, outcome, goldenCopyDate, degraded } = await lookup(
    asked.lei,
    origin,
    deps,
    () => readCodes(env.INDEX_ORIGIN),
    (env.INDEX_ORIGIN ?? "").trim() !== "",
  );
  toCache(cache, key, answer, outcome, goldenCopyDate, degraded, deps, ctx);
  return respond(request, env, { ...answer, headers: { ...answer.headers, "x-cache": "MISS" } });
}

function serveRobots(request: Request, env: Env): Response {
  const allowed = indexable(env, new URL(request.url));
  return respond(request, env, {
    status: 200,
    body: `User-agent: *\n${allowed ? "Allow: /" : "Disallow: /"}\n`,
    contentType: "text/plain; charset=utf-8",
    cacheControl: publicFor(BROWSER_MAX_AGE),
  });
}

export function createWorker(deps: Deps) {
  // The names of codes, kept for a few minutes by this Worker (and in the Cache API).
  const readCodes = createCodesReader({
    fetch: deps.fetch,
    cache: deps.cache,
    now: () => deps.now().getTime(),
    timeoutMs: deps.indexTimeoutMs ?? 2000,
  });
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      const mine = pathname === "/robots.txt" || pathname.startsWith("/lei/");
      if (!mine) return env.ASSETS.fetch(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return respond(request, env, {
          status: 405,
          body: "Method not allowed\n",
          contentType: "text/plain; charset=utf-8",
          cacheControl: "no-store",
          headers: { allow: "GET, HEAD" },
        });
      }
      if (pathname === "/robots.txt") return serveRobots(request, env);
      return serveLei(request, env, ctx, deps, readCodes);
    },
  };
}

export default createWorker({
  // `caches` exists in the Workers runtime only.
  cache: () =>
    (globalThis as unknown as { caches?: { default: CacheLike } }).caches?.default ?? null,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  gleifTimeoutMs: GLEIF_TIMEOUT_MS,
});
