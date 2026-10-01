// Names for the codes a record carries: legal form (ISO 20275) and registration authority.
// They come from the published index, which builds them from GLEIF's code lists
// (`<build>/codes.json`, docs/index-format.md). The Worker reads `index.json` for the current
// build, then that build's `codes.json`.
//
// A page is never worse for a failure here: with no names it shows the codes, as before. So
// every step is bounded in time, and every failure is an answer (null), not an error.

import type { CacheLike } from "./worker.ts";

export interface Codes {
  /** Entity legal form code to the form's name, such as `XJHM` to "Aktiebolag". */
  elf: Readonly<Record<string, string>>;
  /** Registration authority code to the register's keeper, such as `RA000544` to "Bolagsverket". */
  ra: Readonly<Record<string, string>>;
}

export interface CodesDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** The Cache API's default cache. Null where there is none. */
  cache(): CacheLike | null;
  /** Milliseconds, like `Date.now`. */
  now(): number;
  /** How long to wait for the index host, for each of the two requests. */
  timeoutMs: number;
}

/** How long a Worker keeps the names it has read before it looks at `index.json` again. */
export const CODES_TTL_MS = 5 * 60 * 1000;
/** How long it waits before trying again after a failure: the index host may be down. */
export const CODES_RETRY_MS = 30 * 1000;
/** Seconds `index.json` may be reused from the Cache API: it is the file that changes. */
const MANIFEST_CACHE_SECONDS = 300;
const BUILD = /^[0-9]{8}-[0-9a-f]{8,64}$/;
const MAX_CODES_BYTES = 2_000_000;

/** `elf` and `ra` as maps of string to string, or null if this is not a codes file. */
export function parseCodes(value: unknown): Codes | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const names = (section: unknown): Record<string, string> => {
    const out: Record<string, string> = Object.create(null);
    if (typeof section !== "object" || section === null || Array.isArray(section)) return out;
    for (const [code, name] of Object.entries(section)) {
      if (typeof name === "string" && name !== "") out[code] = name;
    }
    return out;
  };
  const { elf, ra } = value as { elf?: unknown; ra?: unknown };
  if (typeof elf !== "object" || elf === null) return null;
  return { elf: names(elf), ra: names(ra) };
}

/**
 * A reader of the names that remembers what it has read. Make one for the Worker's lifetime:
 * the memory is the module-level variable of the spec, and a few minutes long.
 */
export function createCodesReader(deps: CodesDeps) {
  const memory = new Map<string, { codes: Codes | null; until: number }>();
  const reading = new Map<string, Promise<Codes | null>>();

  /** A JSON file from the Cache API, else from the index host (and then into the cache). */
  async function json(url: string, seconds: number): Promise<unknown> {
    const cache = deps.cache();
    const key = new Request(url);
    try {
      const hit = await cache?.match(key);
      if (hit) return await hit.json();
    } catch {
      // A broken cache is a miss.
    }
    const response = await deps.fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_CODES_BYTES) throw new Error(`${url}: too large`);
    const parsed: unknown = JSON.parse(text);
    if (cache) {
      const stored = new Response(text, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${seconds}`,
        },
      });
      // Not awaited for long: the page does not wait for the cache to be written.
      void cache.put(key, stored).catch(() => {});
    }
    return parsed;
  }

  async function read(origin: string): Promise<Codes | null> {
    const manifest = await json(`${origin}/index.json`, MANIFEST_CACHE_SECONDS);
    const build = (manifest as { build?: unknown } | null)?.build;
    if (typeof build !== "string" || !BUILD.test(build)) throw new Error("no build in index.json");
    // A build's files never change.
    return parseCodes(await json(`${origin}/${build}/codes.json`, 365 * 24 * 3600));
  }

  /**
   * The names, or null: no origin, the index host unreachable, a file that is not what it should
   * be. Concurrent calls share one read.
   */
  return async function codes(originSetting: string | undefined): Promise<Codes | null> {
    const origin = (originSetting ?? "").trim().replace(/\/+$/, "");
    if (origin === "") return null;
    const kept = memory.get(origin);
    if (kept && kept.until > deps.now()) return kept.codes;
    const running = reading.get(origin);
    if (running) return running;
    const task = read(origin)
      .then(
        (codes) => {
          memory.set(origin, {
            codes,
            until: deps.now() + (codes ? CODES_TTL_MS : CODES_RETRY_MS),
          });
          return codes;
        },
        () => {
          // Keep what an earlier read found, if anything: slightly old names beat none.
          memory.set(origin, { codes: kept?.codes ?? null, until: deps.now() + CODES_RETRY_MS });
          return kept?.codes ?? null;
        },
      )
      .finally(() => reading.delete(origin));
    reading.set(origin, task);
    return task;
  };
}
