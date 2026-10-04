// The site Worker. It answers `/lei/*` and `/robots.txt` only (`run_worker_first` in
// wrangler.jsonc); every other path is a static asset and costs nothing.
//
// /lei/<code>, /lei/<code>.json and /lei/<code>.md: redirect to the canonical form, reject bad
// check digits without calling GLEIF, then serve from the Cache API or fetch the record live.
// What is cached is the record document (record-document.ts); the page, the JSON and the
// Markdown are rendered from it on each request. See DESIGN.md decisions 2, 17 and 18.

import { isValidLei } from "@whichlei/core";
import { type Fetch, fetchNames, fetchRecord, GleifError } from "@whichlei/gleif";
import { type Codes, createCodesReader } from "./codes.ts";
import { renderMarkdown, renderMarkdownMessage } from "./markdown.ts";
import { type Format, pickFormat } from "./negotiate.ts";
import { renderDocumentPage, renderMessagePage } from "./record.ts";
import {
  buildDocument,
  leisToName,
  parseDocument,
  type RecordDocument,
} from "./record-document.ts";
import { robotsText } from "./robots.ts";
import { cacheTtl, DEGRADED_TTL } from "./ttl.ts";

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
  /**
   * The Worker version serving this request (`version_metadata` in wrangler.jsonc). Its id is
   * sent as `x-whichlei-version`, so the deploy workflow can wait until a host serves the
   * version it deployed (scripts/wait-for-version.ts).
   */
  CF_VERSION_METADATA?: { id: string };
}

// Names the Worker version on every answer of the Worker's own. Not exported: the runtime takes
// every named export of this module for an entrypoint.
const VERSION_HEADER = "x-whichlei-version";

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
  /** How long to wait for the names of linked entities, after the record. Defaults to 3000. */
  namesTimeoutMs?: number;
}

const BROWSER_MAX_AGE = 3600;
const REDIRECT_MAX_AGE = 86400;
const DEFAULT_RETRY_AFTER = 60;
const GLEIF_TIMEOUT_MS = 8000;
const NAMES_TIMEOUT_MS = 3000;
// At most this many linked entities are named; the rest show their LEI.
const MAX_NAMES = 50;

// The cache key of a record document. Never a public URL: the production Worker before this one
// kept rendered HTML under `<origin>/lei/<LEI>`, and that must never be read as a document.
// Change the number when the document's shape changes, so older entries are not read.
const DOCUMENT_KEY = "doc=1";

// The site itself: styles, fonts and the copy button script are static files. A record page
// fetches nothing but Fathom's script, its page-view image and its beacon (decision 23); the
// stats loader decides on the canonical host whether any of that happens.
const FATHOM = "https://cdn.usefathom.com";
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self'",
  `script-src 'self' ${FATHOM}`,
  `img-src 'self' data: ${FATHOM}`,
  `connect-src ${FATHOM}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

interface Answer {
  status: number;
  body: string;
  /** What the body is. Defaults to HTML. */
  format?: Format;
  /** Defaults to the format's own type. */
  contentType?: string;
  /** Cache-Control for the browser. */
  cacheControl: string;
  headers?: Record<string, string>;
}

const CONTENT_TYPES: Record<Format, string> = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
};

/** `/lei/<code>.json` and `/lei/<code>.md`: the path without its extension, and the extension. */
function splitExtension(pathname: string): { path: string; extension: "" | ".json" | ".md" } {
  const match = /^(.*[^/])(\.json|\.md)(\/?)$/.exec(pathname);
  if (match === null) return { path: pathname, extension: "" };
  return { path: `${match[1]}${match[3]}`, extension: match[2] as ".json" | ".md" };
}

const EXTENSION_FORMATS = { ".json": "json", ".md": "markdown" } as const;

function respond(request: Request, env: Env, answer: Answer): Response {
  const url = new URL(request.url);
  const format = answer.format ?? "html";
  const headers = new Headers({
    "content-type": answer.contentType ?? CONTENT_TYPES[format],
    "cache-control": answer.cacheControl,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "interest-cohort=()",
    "content-security-policy": CSP,
    ...answer.headers,
  });
  const { extension } = splitExtension(url.pathname);
  // `/lei/<code>.json` and `.md` repeat the page and are never indexed. `/lei/<code>` is the
  // canonical URL whatever format it answers in, so it follows the setting like the page.
  if (extension !== "" || !indexable(env, url)) headers.set("x-robots-tag", "noindex");
  // `/lei/<code>` answers in the format `Accept` asks for, whatever the status.
  if (url.pathname.startsWith("/lei/") && extension === "") headers.set("vary", "accept");
  if (env.CF_VERSION_METADATA?.id) headers.set(VERSION_HEADER, env.CF_VERSION_METADATA.id);
  return new Response(request.method === "HEAD" ? null : answer.body, {
    status: answer.status,
    headers,
  });
}

const publicFor = (seconds: number) => `public, max-age=${seconds}`;

/** An answer that is not a record. `heading` and `detail` are the site's own text. */
function message(
  format: Format,
  status: number,
  heading: string,
  detail: string,
  extra: Partial<Answer> = {},
): Answer {
  const body =
    format === "json"
      ? `${JSON.stringify({ error: heading, detail })}\n`
      : format === "markdown"
        ? renderMarkdownMessage(heading, detail)
        : renderMessagePage({ title: heading, heading, detail });
  return { status, format, body, cacheControl: publicFor(BROWSER_MAX_AGE), ...extra };
}

/** The answer for a GLEIF failure. Never cached, by us or the browser. */
function unavailable(format: Format, retryAfter: number | null): Answer {
  const seconds = Math.max(1, retryAfter ?? DEFAULT_RETRY_AFTER);
  return message(
    format,
    503,
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

/** What a request path (without its extension) says about the LEI it asks for. */
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

/** What a lookup found. Cached, except a failure. */
type Looked =
  | {
      kind: "found";
      doc: RecordDocument;
      /** Names that should have been there were not: do not keep it long. */
      degraded: boolean;
    }
  | { kind: "not-found" }
  | { kind: "failure"; retryAfter: number | null };

/** The names of linked entities, or null when GLEIF did not give them in time. */
async function readNames(leis: string[], deps: Deps): Promise<Map<string, string> | null> {
  if (leis.length === 0) return new Map();
  try {
    return await fetchNames(leis, {
      fetch: deps.fetch,
      signal: AbortSignal.timeout(deps.namesTimeoutMs ?? NAMES_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(`names: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Fetch a record and make its document. Anything but a record or an unknown LEI is a failure. */
async function lookup(
  lei: string,
  origin: string,
  deps: Deps,
  codes: () => Promise<Codes | null>,
  expectCodes: boolean,
): Promise<Looked> {
  try {
    const record = await fetchRecord(lei, {
      fetch: deps.fetch,
      signal: AbortSignal.timeout(deps.gleifTimeoutMs),
    });
    // A record for another LEI is an answer we cannot trust: never show or cache it.
    if (record.lei !== lei)
      throw new GleifError("failed", `GLEIF answered ${record.lei} for ${lei}`);
    // Only for a record that is going to be shown: an unknown LEI costs the index host and
    // GLEIF nothing more. Neither ever rejects: a page without names is still a page.
    const [codeNames, linkedNames] = await Promise.all([
      codes(),
      readNames(leisToName(record, MAX_NAMES), deps),
    ]);
    // Names that should have been there and were not: no browser keeps the page for an hour,
    // and the cache does not keep it for a day.
    const degraded = (expectCodes && codeNames === null) || linkedNames === null;
    const doc = buildDocument(record, {
      canonicalOrigin: origin,
      codes: codeNames,
      names: linkedNames,
    });
    return { kind: "found", doc, degraded };
  } catch (error) {
    if (error instanceof GleifError && error.kind === "not-found") return { kind: "not-found" };
    return { kind: "failure", retryAfter: error instanceof GleifError ? error.retryAfter : null };
  }
}

function render(format: Format, doc: RecordDocument, origin: string): string {
  switch (format) {
    case "html":
      return renderDocumentPage(doc, origin);
    case "json":
      return `${JSON.stringify(doc, null, 2)}\n`;
    case "markdown":
      return renderMarkdown(doc, origin);
  }
}

/** The answer in the format asked for. `browserMaxAge` is how long a browser may keep it. */
function answerFor(
  format: Format,
  looked: Looked,
  lei: string,
  origin: string,
  browserMaxAge: number,
): Answer {
  switch (looked.kind) {
    case "found":
      return {
        status: 200,
        format,
        body: render(format, looked.doc, origin),
        cacheControl: publicFor(browserMaxAge),
      };
    case "not-found":
      return message(
        format,
        404,
        "No such LEI",
        `GLEIF has no record for ${lei}. The code is well formed, but no entity has it.`,
        { cacheControl: publicFor(browserMaxAge) },
      );
    case "failure":
      return unavailable(format, looked.retryAfter);
  }
}

async function fromCache(
  cache: CacheLike | null,
  key: Request,
): Promise<{ looked: Looked; browserMaxAge: number } | null> {
  if (cache === null) return null;
  try {
    const hit = await cache.match(key);
    if (hit === undefined) return null;
    // A browser never keeps a page longer than the cache does: a page stored for 5 minutes
    // (names missing) is kept by browsers for 5 minutes too.
    const stored = Number(/max-age=(\d+)/.exec(hit.headers.get("cache-control") ?? "")?.[1]);
    const browserMaxAge = Number.isFinite(stored)
      ? Math.min(BROWSER_MAX_AGE, stored)
      : BROWSER_MAX_AGE;
    if (hit.status === 404) return { looked: { kind: "not-found" }, browserMaxAge };
    if (hit.status !== 200) return null;
    const doc = parseDocument(await hit.text());
    // Not a document: treated as a miss, and replaced.
    return doc === null ? null : { looked: { kind: "found", doc, degraded: false }, browserMaxAge };
  } catch {
    return null;
  }
}

function toCache(
  cache: CacheLike | null,
  key: Request,
  looked: Looked,
  deps: Deps,
  ctx: ExecutionContext,
) {
  if (cache === null || looked.kind === "failure") return;
  const full = cacheTtl(
    looked.kind,
    deps.now(),
    looked.kind === "found" ? looked.doc.source.goldenCopyDate : null,
  );
  const ttl = looked.kind === "found" && looked.degraded ? Math.min(full, DEGRADED_TTL) : full;
  if (ttl === 0) return;
  const stored =
    looked.kind === "found"
      ? new Response(JSON.stringify(looked.doc), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": publicFor(ttl) },
        })
      : new Response(null, { status: 404, headers: { "cache-control": publicFor(ttl) } });
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
  const { path, extension } = splitExtension(url.pathname);
  const format =
    extension === "" ? pickFormat(request.headers.get("accept")) : EXTENSION_FORMATS[extension];
  const asked = readLeiPath(path);
  const origin = canonicalOrigin(env, url);
  // The JSON and the Markdown point at the page they repeat.
  const reply = (answer: Answer) =>
    respond(
      request,
      env,
      format === "html" || asked === null
        ? answer
        : {
            ...answer,
            headers: { ...answer.headers, link: `<${origin}/lei/${asked.lei}>; rel="canonical"` },
          },
    );
  if (asked === null) {
    return reply(
      message(
        format,
        404,
        "Not an LEI",
        "An LEI has 20 characters: letters and digits, the last two digits. Check what you typed.",
      ),
    );
  }
  if (!asked.canonical) {
    return reply({
      status: 301,
      format,
      body: "",
      contentType: "text/plain; charset=utf-8",
      cacheControl: publicFor(REDIRECT_MAX_AGE),
      headers: { location: `${origin}/lei/${asked.lei}${extension}` },
    });
  }
  if (!isValidLei(asked.lei)) {
    return reply(
      message(
        format,
        404,
        "Not a valid LEI",
        `${asked.lei} is not an LEI: its check digits do not match (ISO 7064 mod 97-10). Check what you typed.`,
      ),
    );
  }

  // The key is not the public URL: a document is not a page, and the query string, which a
  // crawler can vary at will, is not part of it.
  const key = new Request(`${origin}/lei/${asked.lei}?${DOCUMENT_KEY}`);
  const cache = deps.cache();
  const cached = await fromCache(cache, key);
  if (cached !== null) {
    const answer = answerFor(format, cached.looked, asked.lei, origin, cached.browserMaxAge);
    return reply({ ...answer, headers: { ...answer.headers, "x-cache": "HIT" } });
  }

  const looked = await lookup(
    asked.lei,
    origin,
    deps,
    () => readCodes(env.INDEX_ORIGIN),
    (env.INDEX_ORIGIN ?? "").trim() !== "",
  );
  toCache(cache, key, looked, deps, ctx);
  const degraded = looked.kind === "found" && looked.degraded;
  const answer = answerFor(
    format,
    looked,
    asked.lei,
    origin,
    degraded ? DEGRADED_TTL : BROWSER_MAX_AGE,
  );
  return reply({ ...answer, headers: { ...answer.headers, "x-cache": "MISS" } });
}

function serveRobots(request: Request, env: Env): Response {
  const url = new URL(request.url);
  return respond(request, env, {
    status: 200,
    body: robotsText(indexable(env, url), canonicalOrigin(env, url)),
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
