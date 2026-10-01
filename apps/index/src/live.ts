// Reading the live index: its manifest, its report, with retries. Shared by checks, assemble
// and verify-live.
import { type Manifest, parseManifest } from "@whichlei/core";
import type { PublishedReport } from "./report.ts";

export type Fetch = typeof fetch;

export interface Http {
  fetch: Fetch;
  /** Waits; replaced in tests. */
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export const realHttp = (log: (message: string) => void = () => {}): Http => ({
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log,
});

/**
 * Runs `attempt` until it returns a result `retryable` does not reject, up to `attempts`
 * times with a growing pause. A throw counts as a failed attempt. Throws after the last.
 */
export async function withRetry<T>(
  sleep: Http["sleep"],
  what: string,
  attempt: () => Promise<T>,
  retryable: (result: T) => string | undefined,
  { attempts = 4, baseDelayMs = 500 } = {},
): Promise<T> {
  let last = "";
  for (let n = 1; n <= attempts; n++) {
    try {
      const result = await attempt();
      const problem = retryable(result);
      if (problem === undefined) return result;
      last = problem;
    } catch (error) {
      last = (error as Error).message;
    }
    if (n < attempts) await sleep(baseDelayMs * 2 ** (n - 1));
  }
  throw new Error(`${what}: failed after ${attempts} attempts: ${last}`);
}

/** A status worth another try: rate limited, or the server's fault. */
export const transient = (status: number): boolean => status === 429 || status >= 500;

/**
 * GET with retries on network errors, 429 and 5xx. Any other status is returned as it is,
 * so the caller decides what a 404 means.
 */
export async function getRetry(
  http: Http,
  url: string,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  return withRetry(
    http.sleep,
    url,
    () => http.fetch(url),
    (response) => {
      if (!transient(response.status)) return undefined;
      void response.body?.cancel();
      return `HTTP ${response.status}`;
    },
    options,
  );
}

const trimSlash = (origin: string) => origin.replace(/\/+$/, "");

/**
 * The live manifest, or undefined if there is no live index. Undefined means: a 404 (no
 * Worker, or no index.json in it yet), or an index.json this code cannot read (a loud
 * warning: nothing can be kept from it). Any other failure throws, so a network fault is
 * never taken for a first publish.
 */
export async function liveManifest(http: Http, origin: string): Promise<Manifest | undefined> {
  // The query string only defeats any cache between here and the Worker.
  const response = await getRetry(http, `${trimSlash(origin)}/index.json?v=${Date.now()}`);
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${origin}/index.json: HTTP ${response.status}`);
  }
  try {
    return parseManifest(await response.json());
  } catch (error) {
    http.log(`::warning::the live index.json is unreadable, so none of it is kept: ${error}`);
    return undefined;
  }
}

/** The live build's report, or undefined if it has none (a 404 or unreadable). */
export async function liveReport(
  http: Http,
  origin: string,
  build: string,
): Promise<PublishedReport | undefined> {
  const response = await getRetry(http, `${trimSlash(origin)}/${build}/report.json`);
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) throw new Error(`${origin}/${build}/report.json: HTTP ${response.status}`);
  try {
    return (await response.json()) as PublishedReport;
  } catch {
    return undefined;
  }
}
