// Slice 10: choose the weights of the new match features on the train half of the
// evaluation set, over a built index directory, with the reference's weights fixed.
//
//   node scripts/fit.ts --index <built index dir> [--out fit.json] [--initials 0,6.5]
//                       [--base-exact 0,1]     (the grids, comma-separated)
//
// Every query is routed and scored once; the features of every candidate name are kept,
// so each grid point only re-adds weights. The criterion is the mean MRR@10 over the six
// strata of the objective plus the acronym set (research/ranking/eval/acronyms.tsv), on
// train. It reads no test-half result: compare.ts reports the test half once the weights
// are chosen.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  decodeEntries,
  filePath,
  INITIALS_MIN_PROMINENCE,
  type MatchWeights,
  matchFeatures,
  matchScore,
  memoLevel,
  parseManifest,
  queryTokens,
  REFERENCE_MATCH_WEIGHTS,
  route,
  routingTable,
  toCandidate,
} from "@whichlei/core";
import { type EvalQuery, loadAcronyms, loadEval, STRATA } from "../src/evaluation.ts";

const { values } = parseArgs({
  options: {
    index: { type: "string" },
    out: { type: "string" },
    initials: { type: "string", default: "0,4,4.5,5,5.5,6,6.5,7,7.5,8,9,10" },
    "base-exact": { type: "string", default: "0,0.25,0.5,0.75,1,1.25,1.5,2" },
  },
});
const dir = values.index as string;
const log = (...args: unknown[]) =>
  console.error(`[${process.uptime().toFixed(0).padStart(4)}s]`, ...args);
const grid = (s: string) => s.split(",").map(Number);

const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
const table = routingTable(manifest);
type C = ReturnType<typeof toCandidate>;
const cache = new Map<number, C[]>();
const candidates = (file: number): C[] => {
  let list = cache.get(file);
  if (list === undefined) {
    const text = readFileSync(join(dir, filePath(manifest, file)), "utf8");
    list = decodeEntries(text).map(toCandidate);
    if (cache.size >= 300) cache.delete(cache.keys().next().value as number);
  } else cache.delete(file);
  cache.set(file, list);
  return list;
};

const rows = [...loadEval(), ...loadAcronyms()];
const STRATA7 = [...STRATA, "acronym"];

/**
 * One query's candidates. Per candidate name, `feat` holds: score under the reference
 * weights (NaN when not shown), initials (0/1), base exact (0/1).
 */
interface Pool {
  ids: string[];
  prominence: Float64Array;
  /** Names of candidate i are feat rows nameStart[i] .. nameStart[i + 1]. */
  nameStart: Int32Array;
  feat: Float64Array;
}
const pools = new Map<string, Pool>();
for (const { query } of rows) {
  if (pools.has(query)) continue;
  const tokens = queryTokens(query);
  const pool = new Map<string, C>();
  if (tokens.length > 0) {
    for (const f of route(tokens, table)) for (const c of candidates(f)) pool.set(c.id, c);
  }
  const level = memoLevel();
  const ids: string[] = [];
  const prominence: number[] = [];
  const nameStart: number[] = [0];
  const feat: number[] = [];
  for (const c of pool.values()) {
    let any = false;
    for (const name of c.names) {
      const f = matchFeatures(tokens, name, level, c.prominence >= INITIALS_MIN_PROMINENCE);
      const s0 = matchScore(f, REFERENCE_MATCH_WEIGHTS);
      if (s0 === null && !f.initials) continue;
      any = true;
      feat.push(s0 ?? Number.NaN, f.initials ? 1 : 0, f.baseExact ? 1 : 0);
    }
    if (!any) continue;
    ids.push(c.id);
    prominence.push(c.prominence);
    nameStart.push(feat.length / 3);
  }
  pools.set(query, {
    ids,
    prominence: Float64Array.from(prominence),
    nameStart: Int32Array.from(nameStart),
    feat: Float64Array.from(feat),
  });
}
log(`${pools.size} queries scored once`);

/** Score of a name as matchScore computes it, from the kept features. */
function nameScore(feat: Float64Array, row: number, w: MatchWeights): number | null {
  const s0 = feat[row * 3] as number;
  const initials = feat[row * 3 + 1] === 1 && w.m_initials !== 0 ? w.m_initials : null;
  if (Number.isNaN(s0)) return initials;
  const s = s0 + (feat[row * 3 + 2] === 1 ? w.m_base_exact : 0);
  return initials !== null && initials > s ? initials : s;
}

/** Rank of the best-scoring target (1-based), 0 when none scores. Ties: lower id first. */
function rankOf(pool: Pool, targets: ReadonlySet<string>, w: MatchWeights): number {
  const n = pool.ids.length;
  const score = new Float64Array(n);
  let best = -1;
  for (let i = 0; i < n; i++) {
    let s: number | null = null;
    for (let r = pool.nameStart[i] as number; r < (pool.nameStart[i + 1] as number); r++) {
      const m = nameScore(pool.feat, r, w);
      if (m !== null && (s === null || m > s)) s = m;
    }
    score[i] = s === null ? Number.NEGATIVE_INFINITY : s + (pool.prominence[i] as number);
    if (targets.has(pool.ids[i] as string) && score[i] !== Number.NEGATIVE_INFINITY) {
      if (
        best < 0 ||
        (score[i] as number) > (score[best] as number) ||
        (score[i] === score[best] && (pool.ids[i] as string) < (pool.ids[best] as string))
      )
        best = i;
    }
  }
  if (best < 0) return 0;
  let rank = 1;
  const sb = score[best] as number;
  const idb = pool.ids[best] as string;
  for (let i = 0; i < n; i++) {
    const s = score[i] as number;
    if (s > sb || (s === sb && (pool.ids[i] as string) < idb)) rank++;
  }
  return rank;
}

const rr = (rank: number) => (rank >= 1 && rank <= 10 ? 1 / rank : 0);

function reciprocalRanks(w: MatchWeights): Float64Array {
  return Float64Array.from(rows, (r) => rr(rankOf(pools.get(r.query) as Pool, r.targets, w)));
}

/** MRR@10 per stratum (seven), for the rows in `take`. */
function perStratum(
  rrs: Float64Array,
  take: (r: EvalQuery, i: number) => number,
): Record<string, number> {
  const sum: Record<string, number> = {};
  const count: Record<string, number> = {};
  rows.forEach((r, i) => {
    const k = take(r, i);
    if (k === 0) return;
    sum[r.stratum] = (sum[r.stratum] ?? 0) + k * (rrs[i] as number);
    count[r.stratum] = (count[r.stratum] ?? 0) + k;
  });
  const out: Record<string, number> = {};
  for (const s of STRATA7) out[s] = (sum[s] ?? 0) / (count[s] ?? 1);
  out.objective = STRATA.reduce((a, s) => a + (out[s] as number), 0) / STRATA.length;
  out.criterion = STRATA7.reduce((a, s) => a + (out[s] as number), 0) / STRATA7.length;
  return out;
}
const inSplit = (split: string) => (r: EvalQuery) => (r.split === split ? 1 : 0);

// ---- Grid on train ------------------------------------------------------------------
const results: { w: Partial<MatchWeights>; train: Record<string, number> }[] = [];
for (const m_initials of grid(values.initials as string)) {
  for (const m_base_exact of grid(values["base-exact"] as string)) {
    const w = { ...REFERENCE_MATCH_WEIGHTS, m_initials, m_base_exact };
    results.push({
      w: { m_initials, m_base_exact },
      train: perStratum(reciprocalRanks(w), inSplit("train")),
    });
  }
}
results.sort((a, b) => (b.train.criterion as number) - (a.train.criterion as number));
const fmt = (o: Record<string, number>) =>
  ["objective", "criterion", ...STRATA7]
    .map((k) => `${k} ${(o[k] as number).toFixed(4)}`)
    .join("  ");
log(`grid: ${results.length} points; best on train:`);
for (const r of results.slice(0, 15)) log(`  ${JSON.stringify(r.w)}  ${fmt(r.train)}`);
const zero = results.find((r) => r.w.m_initials === 0 && r.w.m_base_exact === 0);
log(`  reference: ${fmt(zero?.train ?? {})}`);
// One feature at a time, the others at 0: each one's own effect on train.
for (const key of ["m_initials", "m_base_exact"] as const) {
  const alone = results
    .filter((r) => Object.entries(r.w).every(([k, v]) => k === key || v === 0))
    .sort((a, b) => (b.train.criterion as number) - (a.train.criterion as number))[0];
  if (alone) log(`  ${key} alone: ${JSON.stringify(alone.w)}  ${fmt(alone.train)}`);
}

// ---- The chosen point on train. The test half is compare.ts's job, after the choice. ---
const chosen = { ...REFERENCE_MATCH_WEIGHTS, ...(results[0]?.w ?? {}) };
const report: Record<string, unknown> = {
  chosen: results[0]?.w,
  grid: results.slice(0, 50),
  train: {
    before: perStratum(reciprocalRanks(REFERENCE_MATCH_WEIGHTS), inSplit("train")),
    after: perStratum(reciprocalRanks(chosen), inSplit("train")),
  },
};
log(`chosen: ${JSON.stringify(results[0]?.w)}`);
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 1));
