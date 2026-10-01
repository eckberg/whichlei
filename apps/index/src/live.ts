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
 * GET with retries on network errors, 429 and 5xx. Any other status is returned as it is,
 * so the caller decides what a 404 means.
 */
export async function getRetry(
  http: Http,
  url: string,
  { attempts = 4, baseDelayMs = 500 } = {},
): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await http.fetch(url);
      if (response.status !== 429 && response.status < 500) return response;
      await response.body?.cancel();
      last = new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    if (attempt < attempts) await http.sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  throw new Error(`${url}: failed after ${attempts} attempts: ${(last as Error).message}`);
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
