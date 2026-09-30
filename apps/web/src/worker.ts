// The site Worker. It answers `/lei/*` and `/robots.txt` only (`run_worker_first` in
// wrangler.jsonc); every other path is a static asset and costs nothing.
//
// /lei/<code>: redirect to the canonical form, reject bad check digits without calling GLEIF,
// then serve from the Cache API or fetch the record live and render it. See DESIGN.md
// decisions 2, 17 and 18.

import { isValidLei } from "@whichlei/core";
import { type Fetch, fetchRecord, GleifError } from "@whichlei/gleif";
import { renderMessagePage, renderRecordPage } from "./record.ts";
import { type CacheOutcome, cacheTtl } from "./ttl.ts";

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
  /** `"true"` lets crawlers in. Anything else keeps the site out of search engines. */
  ALLOW_INDEXING?: string;
  /** Origin for canonical links, such as `https://whichlei.com`. Default: the request's own. */
  CANONICAL_ORIGIN?: string;
}

export interface Deps {
  /** The Cache API's default cache. Null where there is none: nothing is cached then. */
  cache(): CacheLike | null;
  /** Used for GLEIF. */
  fetch: Fetch;
  now(): Date;
}

const BROWSER_MAX_AGE = 3600;
const REDIRECT_MAX_AGE = 86400;
const DEFAULT_RETRY_AFTER = 60;
const GLEIF_TIMEOUT_MS = 8000;

// Only the site itself and the font hosts. The copy button script is a static file.
const CSP = [
  "default-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self'",
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
  const headers = new Headers({
    "content-type": answer.contentType ?? "text/html; charset=utf-8",
    "cache-control": answer.cacheControl,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "interest-cohort=()",
    "content-security-policy": CSP,
    ...answer.headers,
  });
  if (env.ALLOW_INDEXING !== "true") headers.set("x-robots-tag", "noindex");
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

const canonicalOrigin = (env: Env, url: URL): string => {
  try {
    if (env.CANONICAL_ORIGIN) {
      const origin = new URL(env.CANONICAL_ORIGIN);
      if (origin.protocol === "https:" || origin.protocol === "http:") return origin.origin;
    }
  } catch {
    // Not a URL: use the request's own origin.
  }
  return url.origin;
};

const asciiUpper = (text: string) => text.replace(/[a-z]/g, (c) => c.toUpperCase());

/** What a request path says about the LEI it asks for. */
export function readLeiPath(pathname: string): { lei: string; canonical: boolean } | null {
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
): Promise<{ answer: Answer; outcome: CacheOutcome }> {
  try {
    const record = await fetchRecord(lei, {
      fetch: deps.fetch,
      signal: AbortSignal.timeout(GLEIF_TIMEOUT_MS),
    });
    const answer = {
      status: 200,
      body: renderRecordPage(record, { canonicalOrigin: origin }),
      cacheControl: publicFor(BROWSER_MAX_AGE),
    };
    return { answer, outcome: "found" };
  } catch (error) {
    if (error instanceof GleifError && error.kind === "not-found") {
      const answer = message(
        404,
        "No such LEI",
        "No such LEI",
        `GLEIF has no record for ${lei}. The code is well formed, but no entity has it.`,
      );
      return { answer, outcome: "not-found" };
    }
    const retryAfter = error instanceof GleifError ? error.retryAfter : null;
    return { answer: unavailable(retryAfter), outcome: "failure" };
  }
}

async function fromCache(cache: CacheLike | null, key: Request): Promise<Answer | null> {
  if (cache === null) return null;
  try {
    const hit = await cache.match(key);
    if (hit === undefined) return null;
    return {
      status: hit.status,
      body: await hit.text(),
      cacheControl: publicFor(BROWSER_MAX_AGE),
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
  deps: Deps,
  ctx: ExecutionContext,
) {
  const ttl = cacheTtl(outcome, deps.now());
  if (cache === null || ttl === 0) return;
  const stored = new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": publicFor(ttl) },
  });
  ctx.waitUntil(cache.put(key, stored).catch(() => {}));
}

async function serveLei(request: Request, env: Env, ctx: ExecutionContext, deps: Deps) {
  const url = new URL(request.url);
  const asked = readLeiPath(url.pathname);
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
      headers: { location: new URL(`/lei/${asked.lei}`, url).href },
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

  const origin = canonicalOrigin(env, url);
  const key = new Request(`${origin}/lei/${asked.lei}`);
  const cache = deps.cache();
  const cached = await fromCache(cache, key);
  if (cached !== null) return respond(request, env, cached);

  const { answer, outcome } = await lookup(asked.lei, origin, deps);
  toCache(cache, key, answer, outcome, deps, ctx);
  return respond(request, env, { ...answer, headers: { ...answer.headers, "x-cache": "MISS" } });
}

function serveRobots(env: Env): Response {
  const allowed = env.ALLOW_INDEXING === "true";
  return new Response(`User-agent: *\n${allowed ? "Allow: /" : "Disallow: /"}\n`, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": publicFor(BROWSER_MAX_AGE),
      "x-content-type-options": "nosniff",
    },
  });
}

export function createWorker(deps: Deps) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === "/robots.txt") return serveRobots(env);
      if (!pathname.startsWith("/lei/")) return env.ASSETS.fetch(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed\n", {
          status: 405,
          headers: { allow: "GET, HEAD", "cache-control": "no-store" },
        });
      }
      return serveLei(request, env, ctx, deps);
    },
  };
}

export default createWorker({
  // `caches` exists in the Workers runtime only.
  cache: () => (globalThis as { caches?: { default: CacheLike } }).caches?.default ?? null,
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
});
