// Waits until a host serves the Worker version just deployed, so the tests that follow test it:
//
//   node scripts/wait-for-version.ts <origin> <version id>      (or: pnpm wait-for-version)
//
// Right after `wrangler deploy`, a host can still answer with the previous version: in the
// deploy of 2026-10-04, the tests started 22 s after the deploy and their first requests got
// the version before. The Worker names its version in `x-whichlei-version` (wrangler.jsonc),
// and this asks /robots.txt, which the Worker answers without calling anything, until the
// new version answers several times in a row. Fails after the time limit.

// The same name as in src/worker.ts; the tests of both check it.
const VERSION_HEADER = "x-whichlei-version";

export interface WaitOptions {
  origin: string;
  version: string;
  /** Answers in a row that must name the version. */
  inARow?: number;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Resolves with the number of requests made, or rejects when the time runs out. */
export async function waitForVersion(options: WaitOptions): Promise<number> {
  const {
    origin,
    version,
    inARow = 5,
    intervalMs = 2000,
    timeoutMs = 180_000,
    fetch: get = (url, init) => fetch(url, init),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = console.log,
  } = options;
  const url = new URL("/robots.txt", origin).href;
  const deadline = now() + timeoutMs;
  let streak = 0;
  for (let attempt = 1; ; attempt++) {
    let served: string;
    try {
      const response = await get(url, {
        method: "HEAD",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      served = response.headers.get(VERSION_HEADER) ?? `no version (HTTP ${response.status})`;
    } catch (error) {
      served = `no answer (${error instanceof Error ? error.message : String(error)})`;
    }
    streak = served === version ? streak + 1 : 0;
    if (streak === inARow) {
      log(`${origin} serves ${version}: ${inARow} answers in a row, ${attempt} requests`);
      return attempt;
    }
    if (streak === 0) log(`attempt ${attempt}: ${origin} serves ${served}`);
    if (now() + intervalMs > deadline) {
      throw new Error(`${origin} did not serve ${version} within ${timeoutMs / 1000} s`);
    }
    await sleep(intervalMs);
  }
}

if (import.meta.main) {
  const [origin, version] = process.argv.slice(2);
  if (!origin || !version) {
    console.error("usage: node scripts/wait-for-version.ts <origin> <version id>");
    process.exit(2);
  }
  try {
    await waitForVersion({ origin, version });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
