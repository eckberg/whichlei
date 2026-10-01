// Time parsing and scoring in Chromium with CPU throttling.
//
//   pnpm --filter @whichlei/bench browser [--rates 1,4,6] [--encodings json,lines]
//                                         [--every 1] [--files-every 1]
//
// Serves the repository (TypeScript stripped of types) and $DATA_DIR/format, opens
// page/index.html, and for each encoding and CPU slowdown replays every evaluation query
// (every Nth with --every) keystroke by keystroke, and parses every file (every Nth with
// --files-every). 4x is Lighthouse's mobile setting, our stand-in for a mid-range phone.
// Writes $DATA_DIR/format/browser-<encoding>-<rate>x[-every<N>].json.
// CHROMIUM overrides the browser path (default /opt/pw-browsers/chromium).
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import type { QueryTiming } from "../page/bench.ts";
import { loadEval, REPO, summary } from "../src/evaluation.ts";
import { OUT_DIR } from "./data.ts";

const { values: args } = parseArgs({
  options: {
    rates: { type: "string", default: "1,4,6" },
    encodings: { type: "string", default: "json,lines,lines-tokens" },
    every: { type: "string", default: "1" },
    "files-every": { type: "string", default: "1" },
  },
});
const rates = args.rates.split(",").map(Number);
const encodings = args.encodings.split(",");
const every = Number(args.every);
const filesEvery = Number(args["files-every"]);
const log = (...a: unknown[]) => console.log(`[${process.uptime().toFixed(0).padStart(5)}s]`, ...a);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  const file = path.startsWith("/data/") ? join(OUT_DIR, path.slice(6)) : join(REPO, path);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const ext = extname(file);
  let body: Buffer | string = readFileSync(file);
  if (ext === ".ts") body = stripTypeScriptTypes(body.toString("utf8"));
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" }).end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
});
const expected = JSON.parse(readFileSync(join(OUT_DIR, "top10.json"), "utf8")) as Record<
  string,
  string[]
>;
const queries = [...new Set(loadEval().map((r) => r.query))].filter((_, i) => i % every === 0);
const fmt = (s: ReturnType<typeof summary>) =>
  `${s.median.toFixed(1)} / ${s.p90.toFixed(1)} / ${s.max.toFixed(1)}`;

for (const name of encodings) {
  const fileCount = (
    JSON.parse(readFileSync(join(OUT_DIR, name, "index.json"), "utf8")) as { bounds: string[] }
  ).bounds.length;
  const files = Array.from({ length: fileCount }, (_, i) => i).filter((i) => i % filesEvery === 0);
  for (const rate of rates) {
    // A fresh page per run, so one run's heap does not slow the next.
    const page = await browser.newPage();
    page.on("pageerror", (e) => log("page error", e));
    await page.goto(`${origin}/tools/bench/page/index.html`);
    await page.waitForFunction(() => "bench" in window);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const manifestMs = await page.evaluate((n) => window.bench.load(n), name);

    const timings: QueryTiming[] = [];
    for (let i = 0; i < queries.length; i += 20) {
      const batch = queries.slice(i, i + 20);
      timings.push(...(await page.evaluate((qs) => window.bench.runQueries(qs), batch)));
    }
    const parseMs: number[] = [];
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      parseMs.push(...(await page.evaluate((fs) => window.bench.parseFiles(fs), batch)));
    }
    await page.close();

    const slowest = timings.map((t) => Math.max(0, ...t.keystrokes));
    const slowestParse = timings.map((t) => Math.max(0, ...t.parse));
    const allKeys = timings.flatMap((t) => t.keystrokes);
    const wrongTop = timings.filter((t) => t.top.join() !== (expected[t.query] ?? []).join());
    const result = {
      encoding: name,
      rate,
      queries: timings.length,
      keystrokes: allKeys.length,
      manifestMs,
      slowestKeystroke: summary(slowest),
      slowestParse: summary(slowestParse),
      keystroke: summary(allKeys),
      over: Object.fromEntries(
        [50, 100, 200].map((ms) => [ms, slowest.filter((s) => s > ms).length / slowest.length]),
      ),
      parseFile: summary(parseMs),
      parsedFiles: parseMs.length,
      wrongTop: wrongTop.length,
      slowestQueries: timings
        .map((t, i) => ({ query: t.query, ms: slowest[i] ?? 0, files: t.files }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10),
    };
    const sample = every > 1 ? `-every${every}` : "";
    writeFileSync(
      join(OUT_DIR, `browser-${name}-${rate}x${sample}.json`),
      JSON.stringify(result, null, 1),
    );
    log(
      `${name} at ${rate}x: ${timings.length} queries, ${allKeys.length} keystrokes;` +
        ` slowest keystroke per query ms ${fmt(result.slowestKeystroke)}` +
        ` (parse ${fmt(result.slowestParse)}); every keystroke ${fmt(result.keystroke)};` +
        ` file parse ms ${fmt(result.parseFile)} (${parseMs.length} files);` +
        ` manifest ${manifestMs.toFixed(1)} ms; top 10 differs for ${wrongTop.length}`,
    );
    for (const w of wrongTop.slice(0, 3)) log("  differs:", w.query, w.top.slice(0, 3));
  }
}
await browser.close();
server.close();
