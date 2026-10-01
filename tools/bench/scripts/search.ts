// Measure the production search page against the full reference index, in Chromium.
//
//   pnpm --filter @whichlei/bench search [--rate 4] [--every 4] [--bytes-every 1]
//       [--page-every 16] [--last-every 4] [--modes every,last,inthread]
//       [--skip bytes,timing,page] [--stats on|off] [--settle-ms 0]
//
// Needs the lines encoding of the index in $DATA_DIR/format/lines (pnpm build-index) and
// sizes.json. Three parts, each on the production code from apps/web, not a copy:
//   bytes   Search over the test split at 1x: gzip bytes of the files fetched per query, with
//           the debounce firing on every key and only on the last key (slice 4's two modes).
//   timing  Search on the page's thread over every Nth query at the CPU slowdown --rate:
//           time per keystroke (tokenise, route, decode new files, merge, score). The cost of
//           the search itself, as the Web Worker now carries it.
//   page    The built page, typed into with real key presses at the same slowdown: time from
//           the key press to the frame after its results, long tasks over 50 ms on the main
//           thread, DOM update time. Chromium cannot throttle workers, so the worker is the
//           production one plus a self-slowdown (page/throttled-worker.ts). Modes: `every`
//           (the debounce fires after every key), `last` (keys 50 ms apart), `inthread` (no
//           Worker: the old way, for the long tasks).
// `--stats off` builds the page without the search counter (slice 11); `--stats on` (default)
// keeps it, with a stub `window.fathom` that counts its calls. `--settle-ms 2100` waits that
// long after the last key of each query, so the counter sends and the stub is called.
// Writes $DATA_DIR/format/search-<rate>x.json (merged with an earlier run). Heavy: run it
// under the lock (CLAUDE.md).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build as esbuild } from "esbuild";
import { chromium } from "playwright-core";
import type { SearchRun } from "../page/search.ts";
import { loadEval, REPO, summary } from "../src/evaluation.ts";
import { OUT_DIR } from "./data.ts";
import { serve } from "./serve.ts";

const { values: args } = parseArgs({
  options: {
    rate: { type: "string", default: "4" },
    every: { type: "string", default: "4" },
    "bytes-every": { type: "string", default: "1" },
    "page-every": { type: "string", default: "16" },
    "last-every": { type: "string", default: "4" },
    modes: { type: "string", default: "every,last,inthread" },
    skip: { type: "string", default: "" },
    stats: { type: "string", default: "on" },
    "settle-ms": { type: "string", default: "0" },
    encoding: { type: "string", default: "lines" },
    port: { type: "string", default: "8799" },
  },
});
const rate = Number(args.rate);
const skip = new Set(args.skip.split(","));
const log = (...a: unknown[]) => console.log(`[${process.uptime().toFixed(0).padStart(5)}s]`, ...a);
const fmt = (s: { median: number; p90: number; max: number }, digits = 1) =>
  `${s.median.toFixed(digits)} / ${s.p90.toFixed(digits)} / ${s.max.toFixed(digits)}`;
const KB = 1024;

const rows = loadEval();
const unique = [...new Set(rows.map((r) => r.query))];
const testQueries = [...new Set(rows.filter((r) => r.split === "test").map((r) => r.query))].filter(
  (_, i) => i % Number(args["bytes-every"]) === 0,
);
const timingQueries = unique.filter((_, i) => i % Number(args.every) === 0);
const expected = JSON.parse(readFileSync(join(OUT_DIR, "top10.json"), "utf8")) as Record<
  string,
  string[]
>;
const { sizes } = JSON.parse(readFileSync(join(OUT_DIR, "sizes.json"), "utf8")) as {
  sizes: Record<string, { gzip: number[] }>;
};
const gzip = sizes[args.encoding]?.gzip;
if (!gzip) throw new Error(`no sizes for ${args.encoding}; run build-index`);

// The page under test is built to read the index from this server.
const siteDist = join(OUT_DIR, "site");
const port = Number(args.port);
const origin = `http://127.0.0.1:${port}`;
if (!skip.has("page")) {
  const build = spawnSync("node", ["scripts/build.ts"], {
    cwd: join(REPO, "apps/web"),
    env: { ...process.env, INDEX_ORIGIN: origin, DIST_DIR: siteDist },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("the site did not build");
}
if (args.stats !== "on" && args.stats !== "off") throw new Error("--stats is on or off");
// Without the counter: the page's own build, rebuilt with a stand-in for src/page/stats.ts.
if (!skip.has("page") && args.stats === "off") {
  await esbuild({
    entryPoints: [join(REPO, "apps/web/src/page/index.ts")],
    outfile: join(siteDist, "app.js"),
    bundle: true,
    format: "iife",
    target: "es2024",
    minify: true,
    sourcemap: "linked",
    legalComments: "none",
    logLevel: "warning",
    define: { __INDEX_ORIGIN__: JSON.stringify(origin) },
    plugins: [
      {
        name: "no-stats",
        setup(b) {
          b.onResolve({ filter: /\/stats\.ts$/ }, () => ({
            path: join(REPO, "tools/bench/page/no-stats.ts"),
          }));
        },
      },
    ],
  });
}
const server = await serve();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
});

async function withPage<T>(
  cpuRate: number,
  run: (page: import("playwright-core").Page) => Promise<T>,
) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => log("page error", e));
  await page.goto(`${server.origin}/tools/bench/page/search.html`);
  await page.waitForFunction(() => "benchSearch" in window);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

async function runSearch(
  page: import("playwright-core").Page,
  queries: string[],
  mode: "every" | "last",
): Promise<SearchRun[]> {
  const out: SearchRun[] = [];
  for (let i = 0; i < queries.length; i += 20) {
    const batch = queries.slice(i, i + 20);
    out.push(
      ...(await page.evaluate(
        ([encoding, qs, m]) => window.benchSearch.runSearch(encoding, qs, m),
        [args.encoding, batch, mode] as const,
      )),
    );
  }
  return out;
}

const result: Record<string, unknown> = { rate, encoding: args.encoding };

// ---- Bytes --------------------------------------------------------------------------
if (!skip.has("bytes")) {
  const bytes: Record<string, unknown> = {};
  await withPage(1, async (page) => {
    for (const mode of ["every", "last"] as const) {
      const runs = await runSearch(page, testQueries, mode);
      const kb = summary(runs.map((r) => r.files.reduce((sum, f) => sum + (gzip[f] ?? 0), 0) / KB));
      const wrong = runs.filter((r) => r.top.join() !== (expected[r.query] ?? []).join());
      bytes[mode] = {
        queries: runs.length,
        kb,
        files: summary(runs.map((r) => r.files.length)),
        wrongTop: wrong.length,
      };
      log(
        `bytes, debounce on ${mode} key, ${runs.length} test queries: KB ${fmt(kb, 0)}; ` +
          `top 10 differs from the reference for ${wrong.length}`,
      );
    }
  });
  result.bytes = bytes;
}

// ---- Timing -------------------------------------------------------------------------
if (!skip.has("timing")) {
  const timing: Record<string, unknown> = {};
  await withPage(rate, async (page) => {
    for (const mode of ["every", "last"] as const) {
      const runs = await runSearch(page, timingQueries, mode);
      const slowest = runs.map((r) => Math.max(0, ...r.keystrokes));
      const slowestPass = runs.map((r) => Math.max(0, ...r.slowestPass));
      const all = runs.flatMap((r) => r.keystrokes);
      const wrong = runs.filter((r) => r.top.join() !== (expected[r.query] ?? []).join());
      const over = (ms: number) => slowest.filter((s) => s > ms).length / slowest.length;
      timing[mode] = {
        queries: runs.length,
        keystrokes: all.length,
        slowestKeystroke: summary(slowest),
        slowestPass: summary(slowestPass),
        everyKeystroke: summary(all),
        over: { 50: over(50), 100: over(100), 200: over(200) },
        wrongTop: wrong.length,
        slowestQueries: runs
          .map((r, i) => ({ query: r.query, ms: slowest[i] ?? 0, files: r.files.length }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 8),
      };
      log(
        `timing at ${rate}x, debounce on ${mode} key, ${runs.length} queries, ${all.length} keystrokes: ` +
          `slowest keystroke ms ${fmt(summary(slowest))}; slowest single pass ${fmt(summary(slowestPass))}; ` +
          `every keystroke ${fmt(summary(all))}; over 100 ms ${(over(100) * 100).toFixed(1)}%; ` +
          `top 10 differs for ${wrong.length}`,
      );
    }
  });
  result.timing = timing;
}

// ---- The real page: time to results, long tasks and render ------------------------------
// The built page, typed into with real key presses at the CPU slowdown --rate. The worker is
// the production one, slowed by `throttled-worker.ts` because chromium cannot throttle workers.
// Modes: "every" (the debounce fires after every key), "last" (keys 50 ms apart, so it fires
// only after the last), "inthread" (no Worker: the same Search on the page, debounce on every
// key), for comparing long tasks.
type PageMode = "every" | "last" | "inthread";

interface KeyResult {
  /** Milliseconds from the key press to the frame after its first results were drawn. */
  first: number | null;
  /** The same for the last results of that text: after the pause pass, 150 ms later. */
  final: number | null;
  /** Event Timing: key press to the next paint of its handlers; 0 under the 16 ms floor. */
  event: number;
  /** The DOM updates of the key (build, set, layout), summed. Only when keys are apart. */
  render: number | null;
}

interface PagePerf {
  events: number[];
  renders: number[];
  results: { key: number; d: number }[];
  longtasks: number[];
}

async function runPage(mode: PageMode, queries: string[]) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (e) => log("page error", e));
  await page.addInitScript(
    ([noWorker, stub]: [boolean, boolean]) => {
      if (noWorker) (window as { Worker?: unknown }).Worker = undefined;
      // Stands in for Fathom: counts the events the page's counter sends.
      (window as unknown as { __fathom: number }).__fathom = 0;
      if (stub) {
        (window as unknown as { fathom: unknown }).fathom = {
          trackEvent: () => {
            (window as unknown as { __fathom: number }).__fathom++;
          },
        };
      }
      const perf: PagePerf = { events: [], renders: [], results: [], longtasks: [] };
      (window as unknown as { __perf: PagePerf }).__perf = perf;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === "whichlei:render") perf.renders.push(e.duration);
          else if (e.name === "whichlei:results") {
            const key = ((e as PerformanceMeasure).detail as { key: number }).key;
            perf.results.push({ key, d: e.duration });
          }
        }
      }).observe({ type: "measure" });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) perf.longtasks.push(e.duration);
      }).observe({ type: "longtask" });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) perf.events.push(e.duration);
      }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    },
    [mode === "inthread", args.stats === "on"] as [boolean, boolean],
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const settle = () =>
    page.waitForFunction(() => document.body.dataset.phase !== "loading", null, { polling: 5 });
  const take = () =>
    page.evaluate(() => {
      const perf = (window as unknown as { __perf: PagePerf }).__perf;
      return {
        events: perf.events.splice(0),
        renders: perf.renders.splice(0),
        results: perf.results.splice(0),
        longtasks: perf.longtasks.splice(0),
      };
    });
  // The page numbers its keystrokes (it keeps the text out of the timeline): this is key `k`.
  const keyOf = (taken: { results: PagePerf["results"]; events: number[] }, k: number) => {
    const mine = taken.results.filter((r) => r.key === k);
    return {
      first: mine[0]?.d ?? null,
      final: mine.at(-1)?.d ?? null,
      event: Math.max(0, ...taken.events),
    };
  };

  const out: { query: string; keys: KeyResult[]; longtasks: number[] }[] = [];
  /** Events the stub `window.fathom` received over the run, one per settled query. */
  let fathomEvents = 0;
  for (const query of queries) {
    await page.goto(`${pageServer.origin}/`);
    await page.locator("#meta").getByText("index:").waitFor();
    await page.locator("#q").focus();
    await take();
    const keys: KeyResult[] = [];
    const longtasks: number[] = [];
    if (mode === "last") {
      await page.keyboard.type(query, { delay: 50 });
      await settle();
      await page.waitForTimeout(190);
      await settle();
      const taken = await take();
      longtasks.push(...taken.longtasks);
      for (let k = 1; k <= query.length; k++) {
        keys.push({ ...keyOf(taken, k), event: 0, render: null });
      }
    } else {
      for (let k = 1; k <= query.length; k++) {
        await page.keyboard.type(query[k - 1] as string);
        await settle();
        // The debounce is 150 ms: wait for the pause pass too, and for its files.
        await page.waitForTimeout(190);
        await settle();
        const taken = await take();
        longtasks.push(...taken.longtasks);
        keys.push({
          ...keyOf(taken, k),
          render: taken.renders.reduce((a, b) => a + b, 0),
        });
      }
    }
    // The counter sends once the results have held still for 2 s: wait for it, and count.
    if (Number(args["settle-ms"]) > 0) await page.waitForTimeout(Number(args["settle-ms"]));
    fathomEvents += await page.evaluate(() => (window as unknown as { __fathom: number }).__fathom);
    out.push({ query, keys, longtasks });
  }
  await page.close();

  // Keys that are only spaces have no tokens and no results to time.
  const nums = (pick: (k: KeyResult) => number | null) =>
    out.map((q) => q.keys.map(pick).filter((r): r is number => r !== null));
  const first = nums((k) => k.first);
  const final = nums((k) => k.final);
  const keyCount = out.reduce((n, q) => n + q.keys.length, 0);
  const slowestOf = (per: number[][]) => per.map((t) => Math.max(0, ...t));
  const renders = out
    .flatMap((q) => q.keys.map((k) => k.render))
    .filter((r): r is number => r !== null);
  const events = out.flatMap((q) => q.keys.map((k) => k.event));
  const withLong = out.filter((q) => q.longtasks.length > 0).length;
  const slowestFirst = slowestOf(first);
  const summaryOf = {
    mode,
    queries: out.length,
    keystrokes: keyCount,
    withResults: first.flat().length,
    firstResults: summary(first.flat()),
    firstSlowestPerQuery: summary(slowestFirst),
    firstOver100: slowestFirst.filter((s) => s > 100).length / slowestFirst.length,
    finalResults: summary(final.flat()),
    finalSlowestPerQuery: summary(slowestOf(final)),
    lastKeyFinal: summary(final.map((t) => t.at(-1) ?? 0)),
    eventOverFloor: events.filter((e) => e > 0).length / events.length,
    eventSlowestPerQuery: summary(out.map((q) => Math.max(0, ...q.keys.map((k) => k.event)))),
    longTasks: {
      queriesWith: withLong / out.length,
      total: out.reduce((n, q) => n + q.longtasks.length, 0),
      longest: Math.max(0, ...out.flatMap((q) => q.longtasks)),
      perQuery: summary(out.map((q) => q.longtasks.length)),
    },
    renderPerKey: renders.length > 0 ? summary(renders) : null,
    stats: args.stats,
    settleMs: Number(args["settle-ms"]),
    fathomEvents,
  };
  log(
    `page at ${rate}x, ${mode}, ${out.length} queries, ${keyCount} keys (${summaryOf.withResults} with results):` +
      ` key to FIRST results painted ms ${fmt(summaryOf.firstResults, 0)}, slowest per query ${fmt(summaryOf.firstSlowestPerQuery, 0)}` +
      ` (over 100 ms: ${(summaryOf.firstOver100 * 100).toFixed(1)}%); FINAL (after the pause pass) ${fmt(summaryOf.finalResults, 0)},` +
      ` slowest ${fmt(summaryOf.finalSlowestPerQuery, 0)}, last key ${fmt(summaryOf.lastKeyFinal, 0)};` +
      ` key to next paint over 16 ms on ${(summaryOf.eventOverFloor * 100).toFixed(1)}% of keys, slowest per query ${fmt(summaryOf.eventSlowestPerQuery, 0)};` +
      ` long tasks >50 ms: ${(summaryOf.longTasks.queriesWith * 100).toFixed(1)}% of queries, ${summaryOf.longTasks.total} in all, longest ${summaryOf.longTasks.longest.toFixed(0)} ms` +
      (renders.length > 0 ? `; DOM update per key ${fmt(summary(renders), 1)}` : "") +
      `; counter ${args.stats}, ${fathomEvents} events reached the stub`,
  );
  return summaryOf;
}

let pageServer: Awaited<ReturnType<typeof serve>>;
if (!skip.has("page")) {
  pageServer = await serve({ port, site: { dist: siteDist, encoding: args.encoding } });
  // The production worker, with the slowdown a worker cannot get from the browser.
  await esbuild({
    entryPoints: [join(REPO, "tools/bench/page/throttled-worker.ts")],
    outfile: join(siteDist, "search-worker.js"),
    bundle: true,
    format: "esm",
    target: "es2024",
    minify: true,
    define: { __RATE__: String(rate) },
    logLevel: "warning",
  });
  const modes = args.modes.split(",") as PageMode[];
  const pageResults: Record<string, unknown> = {};
  for (const mode of modes) {
    const every = mode === "last" ? args["last-every"] : args["page-every"];
    const queries = unique.filter((_, i) => i % Number(every) === 0);
    pageResults[mode] = await runPage(mode, queries);
  }
  result.page = pageResults;
  pageServer.close();
}

// A run with --skip keeps what an earlier run of the other parts wrote.
const outFile = join(OUT_DIR, `search-${rate}x.json`);
const before = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
writeFileSync(outFile, JSON.stringify({ ...before, ...result }, null, 1));
await browser.close();
server.close();
