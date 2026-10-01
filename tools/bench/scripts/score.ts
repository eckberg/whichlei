// Scoring time in Node, keystroke by keystroke, for quick comparisons of scorer changes.
// The browser harness (browser.ts) gives the numbers that count.
//
//   pnpm --filter @whichlei/bench score [--every 1]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Candidate,
  decodeEntries,
  filePath,
  parseManifest,
  routingTable,
  toCandidate,
  topK,
} from "@whichlei/core";
import { loadEval, summary } from "../src/evaluation.ts";
import { keystrokes } from "../src/session.ts";
import { OUT_DIR } from "./data.ts";

const { values: args } = parseArgs({ options: { every: { type: "string", default: "1" } } });
const dir = join(OUT_DIR, "lines");
const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
const table = routingTable(manifest);
const queries = [...new Set(loadEval().map((r) => r.query))].filter(
  (_, i) => i % Number(args.every) === 0,
);
const parsed = new Map<number, Candidate<string>[]>();
const file = (f: number) => {
  let c = parsed.get(f);
  if (!c) {
    c = decodeEntries(readFileSync(join(dir, filePath(manifest, f)), "utf8")).map(toCandidate);
    parsed.set(f, c);
  }
  return c;
};

const slowest: number[] = [];
const tops: string[] = [];
let total = 0;
for (const q of queries) {
  let worst = 0;
  for (const s of keystrokes(q, table)) {
    const seen = new Set<string>();
    const candidates = s.paused
      .flatMap(file)
      .filter((c) => !seen.has(c.id) && seen.add(c.id) !== undefined);
    const t0 = performance.now();
    const top = topK(s.tokens, candidates);
    const ms = performance.now() - t0;
    worst = Math.max(worst, ms);
    total += ms;
    if (s.last) tops.push(top.map((c) => c.id).join());
  }
  slowest.push(worst);
  if (parsed.size > 1500) parsed.clear();
}
const s = summary(slowest);
const expected = JSON.parse(readFileSync(join(OUT_DIR, "top10.json"), "utf8")) as Record<
  string,
  string[]
>;
const differ = queries.filter((q, i) => (expected[q] ?? []).join() !== tops[i]).length;
console.log(
  `${queries.length} queries: scoring, slowest keystroke per query ms ${s.median.toFixed(1)} / ` +
    `${s.p90.toFixed(1)} / ${s.max.toFixed(1)}; total ${(total / 1000).toFixed(1)} s; ` +
    `top 10 differs for ${differ}`,
);
const worst = queries.map((q, i) => [slowest[i] ?? 0, q] as const).sort((a, b) => b[0] - a[0]);
console.log(
  "slowest:",
  worst
    .slice(0, 5)
    .map(([ms, q]) => `${q} ${ms.toFixed(0)} ms`)
    .join("; "),
);
