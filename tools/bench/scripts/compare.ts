// Slice 10: compare two replays written by gaps.ts (before, after) on one split: MRR@10 per
// stratum, the objective, the acronym set and the short queries, each with a 95% interval
// for after - before from a clustered bootstrap (target entities resampled jointly across
// strata, 2,000 times, as research/ranking/results.md).
//
//   node scripts/compare.ts <before gaps.json> <after gaps.json> [--split test]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { STRATA } from "../src/evaluation.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { split: { type: "string", default: "test" } },
});
interface Row {
  query: string;
  stratum: string;
  split: string;
  target: string;
  short: boolean;
  rank: number;
}
const load = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { rows: Row[] }).rows;
const before = load(positionals[0] as string);
const after = load(positionals[1] as string);
if (before.length !== after.length || before.some((r, i) => r.query !== after[i]?.query)) {
  throw new Error("the two replays hold different queries");
}
const rows = before.map((r, i) => ({ ...r, after: (after[i] as Row).rank }));
const inSplit = rows.filter((r) => r.split === values.split);
const rr = (rank: number) => (rank >= 1 && rank <= 10 ? 1 / rank : 0);

/** Groups reported: the six strata, the objective (their mean), the acronym set, short queries. */
const GROUPS = [...STRATA, "acronym", "short"];
function measure(weight: (r: (typeof rows)[number]) => number) {
  const sum = { before: {} as Record<string, number>, after: {} as Record<string, number> };
  const count: Record<string, number> = {};
  for (const r of inSplit) {
    const k = weight(r);
    if (k === 0) continue;
    const groups = [r.stratum, ...(r.short ? ["short"] : [])];
    for (const g of groups) {
      sum.before[g] = (sum.before[g] ?? 0) + k * rr(r.rank);
      sum.after[g] = (sum.after[g] ?? 0) + k * rr(r.after);
      count[g] = (count[g] ?? 0) + k;
    }
  }
  const out: Record<string, { before: number; after: number }> = {};
  for (const g of GROUPS) {
    out[g] = {
      before: (sum.before[g] ?? 0) / (count[g] ?? 1),
      after: (sum.after[g] ?? 0) / (count[g] ?? 1),
    };
  }
  const mean = (key: "before" | "after") =>
    STRATA.reduce((a, s) => a + (out[s]?.[key] as number), 0) / STRATA.length;
  out.objective = { before: mean("before"), after: mean("after") };
  return out;
}

const point = measure(() => 1);
const entities = [...new Set(inSplit.map((r) => r.target))];
let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const diffs: Record<string, number[]> = {};
for (let b = 0; b < 2000; b++) {
  const draws = new Map<string, number>();
  for (let i = 0; i < entities.length; i++) {
    const e = entities[Math.floor(random() * entities.length)] as string;
    draws.set(e, (draws.get(e) ?? 0) + 1);
  }
  const m = measure((r) => draws.get(r.target) ?? 0);
  for (const [g, { before: x, after: y }] of Object.entries(m)) {
    const list = diffs[g] ?? [];
    list.push(y - x);
    diffs[g] = list;
  }
}
const n = (g: string) =>
  g === "objective"
    ? inSplit.filter((r) => STRATA.includes(r.stratum)).length
    : inSplit.filter((r) => r.stratum === g || (g === "short" && r.short)).length;
console.log(`${values.split}: MRR@10 before -> after, after - before [95% interval]`);
for (const g of ["objective", ...GROUPS]) {
  const d = (diffs[g] ?? []).sort((a, b) => a - b);
  const lo = d[Math.floor(0.025 * d.length)] as number;
  const hi = d[Math.floor(0.975 * d.length)] as number;
  const p = point[g] as { before: number; after: number };
  console.log(
    `${g.padEnd(12)} n ${String(n(g)).padStart(5)}  ${p.before.toFixed(4)} -> ${p.after.toFixed(4)}  ${(p.after - p.before >= 0 ? "+" : "") + (p.after - p.before).toFixed(4)} [${lo.toFixed(4)}, ${hi.toFixed(4)}]`,
  );
}
// Success@1, the share with the right entity first (DESIGN.md's table).
const first = (key: "rank" | "after", g: string) => {
  const rs = inSplit.filter((r) => r.stratum === g || (g === "short" && r.short));
  return rs.filter((r) => r[key] === 1).length / Math.max(1, rs.length);
};
console.log(
  `S@1 before -> after: ${GROUPS.map((g) => `${g} ${first("rank", g).toFixed(3)} -> ${first("after", g).toFixed(3)}`).join("; ")}`,
);
const changed = inSplit.filter((r) => rr(r.rank) !== rr(r.after));
console.log(`${changed.length} queries changed reciprocal rank:`);
for (const r of changed.sort((a, b) => a.stratum.localeCompare(b.stratum))) {
  console.log(
    `  ${r.stratum.padEnd(12)} ${JSON.stringify(r.query).padEnd(36)} ${r.rank} -> ${r.after}`,
  );
}
