// Measure the production search page against the full reference index, in Chromium.
//
//   pnpm --filter @whichlei/bench search [--rate 4] [--every 4] [--bytes-every 1]
//                                        [--render-every 16] [--skip bytes,timing,render]
//
// Needs the lines encoding of the index in $DATA_DIR/format/lines (pnpm build-index) and
// sizes.json. Three runs, each on the production code from apps/web, not a copy:
//   bytes   Search over the test split at 1x: gzip bytes of the files fetched per query, with
//           the debounce firing on every key and only on the last key (slice 4's two modes).
//   timing  Search over every Nth query at the CPU slowdown --rate: main-thread time per
//           keystroke (tokenise, route, decode new files, merge, score), both modes.
//   render  The built page, typed into with real key presses at the same slowdown, every Nth
//           query (--render-every): time to update the DOM per key, and Event Timing's
//           input-to-paint time. The page reads the index from this server.
// Writes $DATA_DIR/format/search-<rate>x.json (merged with an earlier run). Heavy: run it under the lock (CLAUDE.md).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
    "render-every": { type: "string", default: "16" },
    skip: { type: "string", default: "" },
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
const renderQueries = unique.filter((_, i) => i % Number(args["render-every"]) === 0);
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
if (!skip.has("render")) {
  const build = spawnSync("node", ["scripts/build.ts"], {
    cwd: join(REPO, "apps/web"),
    env: { ...process.env, INDEX_ORIGIN: origin, DIST_DIR: siteDist },
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("the site did not build");
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

// ---- Render, in the real page ---------------------------------------------------------
interface KeyRender {
  render: number;
  renderMax: number;
  /** Event Timing duration of the key's events, input to next paint; 0 under the 16 ms floor. */
  event: number;
}

if (!skip.has("render")) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("pageerror", (e) => log("page error", e));
  await page.addInitScript(() => {
    const perf = { renders: [] as number[], events: [] as number[] };
    (window as unknown as { __perf: typeof perf }).__perf = perf;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === "whichlei:render") perf.renders.push(e.duration);
    }).observe({ type: "measure" });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.events.push(e.duration);
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const settle = () =>
    page.waitForFunction(() => document.body.dataset.phase !== "loading", null, { polling: 5 });
  const perQuery: { query: string; keys: KeyRender[] }[] = [];
  const pageServer = await serve({ port, site: { dist: siteDist, encoding: args.encoding } });
  for (const query of renderQueries) {
    await page.goto(`${pageServer.origin}/`);
    await page.locator("#meta").getByText("index:").waitFor();
    await page.locator("#q").focus();
    const keys: KeyRender[] = [];
    for (const char of query) {
      await page.keyboard.type(char);
      await settle();
      // The debounce is 150 ms: wait for the pause pass too, and for its files.
      await page.waitForTimeout(190);
      await settle();
      const taken = await page.evaluate(() => {
        const perf = (window as unknown as { __perf: { renders: number[]; events: number[] } })
          .__perf;
        return { renders: perf.renders.splice(0), events: perf.events.splice(0) };
      });
      keys.push({
        render: taken.renders.reduce((a, b) => a + b, 0),
        renderMax: Math.max(0, ...taken.renders),
        event: Math.max(0, ...taken.events),
      });
    }
    perQuery.push({ query, keys });
  }
  await page.close();
  pageServer.close();
  const all = perQuery.flatMap((q) => q.keys);
  const slowestRender = perQuery.map((q) => Math.max(0, ...q.keys.map((k) => k.render)));
  const slowestEvent = perQuery.map((q) => Math.max(0, ...q.keys.map((k) => k.event)));
  const reported = all.map((k) => k.event).filter((e) => e > 0);
  result.render = {
    viewport: "390x844 touch",
    queries: perQuery.length,
    keystrokes: all.length,
    renderEveryKey: summary(all.map((k) => k.render)),
    slowestRenderPerQuery: summary(slowestRender),
    eventOverFloor: reported.length / all.length,
    eventWhenOverFloor: summary(reported),
    slowestEventPerQuery: summary(slowestEvent),
  };
  log(
    `render at ${rate}x, ${perQuery.length} queries, ${all.length} keystrokes: DOM update per key ms ${fmt(summary(all.map((k) => k.render)), 2)};` +
      ` slowest per query ${fmt(summary(slowestRender), 2)}; input-to-paint over 16 ms on ${((reported.length / all.length) * 100).toFixed(1)}% of keys,` +
      ` slowest per query ${fmt(summary(slowestEvent), 0)}`,
  );
}

// A run with --skip keeps what an earlier run of the other parts wrote.
const outFile = join(OUT_DIR, `search-${rate}x.json`);
const before = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
writeFileSync(outFile, JSON.stringify({ ...before, ...result }, null, 1));
await browser.close();
server.close();
