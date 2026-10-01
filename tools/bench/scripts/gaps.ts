// Slice 10, ranking gaps: replay the evaluation over a built index directory and report
// per stratum, for the short and acronym subsets, and for the acronym set
// (research/ranking/eval/acronyms.tsv). For each subset query: the target's rank and why it
// is not first (not routed, not a candidate, scored low).
//
//   node scripts/gaps.ts --index <built index dir> [--out gaps.json] [--weights w.json]
//
// --weights: a JSON object of match weights that replaces MATCH_WEIGHTS key by key.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  decodeEntries,
  type Entry,
  filePath,
  MATCH_WEIGHTS,
  type MatchWeights,
  matchLevel,
  parseManifest,
  queryTokens,
  route,
  routingTable,
  scoreCandidate,
  toCandidate,
} from "@whichlei/core";
import { type EvalQuery, loadAcronyms, loadEval, STRATA, summary } from "../src/evaluation.ts";
import { keystrokes, sessionFiles } from "../src/session.ts";

const { values } = parseArgs({
  options: {
    index: { type: "string" },
    out: { type: "string" },
    weights: { type: "string" },
    "no-bytes": { type: "boolean", default: false },
  },
});
const dir = values.index as string;
const weights: MatchWeights = {
  ...MATCH_WEIGHTS,
  ...(values.weights ? JSON.parse(readFileSync(values.weights, "utf8")) : {}),
};
const log = (...args: unknown[]) =>
  console.error(`[${process.uptime().toFixed(0).padStart(4)}s]`, ...args);

const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
const table = routingTable(manifest);
const read = (n: number) => readFileSync(join(dir, filePath(manifest, n)));

type C = ReturnType<typeof toCandidate>;
const cache = new Map<number, C[]>();
const candidates = (file: number): C[] => {
  let list = cache.get(file);
  if (list === undefined) {
    list = decodeEntries(read(file).toString("utf8")).map(toCandidate);
    if (cache.size >= 300) cache.delete(cache.keys().next().value as number);
  } else cache.delete(file);
  cache.set(file, list);
  return list;
};

const rows = loadEval();
const acronyms = loadAcronyms();
const all = [...rows, ...acronyms];

// Where each target sits: the files that hold it, and its entry.
const targets = new Set(all.flatMap((r) => [...r.targets]));
const filesOf = new Map<string, number[]>();
const entryOf = new Map<string, Entry>();
const gzip: number[] = [];
let raw = 0;
let entries = 0;
for (let n = 0; n < manifest.bounds.length; n++) {
  const buffer = read(n);
  raw += buffer.length;
  if (!values["no-bytes"]) gzip.push(gzipSync(buffer, { level: 6 }).length);
  const list = decodeEntries(buffer.toString("utf8"));
  entries += list.length;
  for (const e of list) {
    if (!targets.has(e.lei)) continue;
    entryOf.set(e.lei, e);
    filesOf.set(e.lei, [...(filesOf.get(e.lei) ?? []), n]);
  }
}
const gzipTotal = gzip.reduce((a, b) => a + b, 0);
log(
  `${manifest.bounds.length} files, ${entries.toLocaleString()} entries, ${(raw / 1e6).toFixed(1)} MB raw, ${(gzipTotal / 1e6).toFixed(1)} MB gzip`,
);

/** A query is short when it is one token of 2 to 4 characters. */
const isShort = (q: string) => {
  const t = queryTokens(q);
  return t.length === 1 && (t[0] as string).length >= 2 && (t[0] as string).length <= 4;
};
/** No target name has a word, or extra, that starts with the (single) query token. */
const noWordMatch = (r: EvalQuery) => {
  const t = queryTokens(r.query);
  if (t.length !== 1) return false;
  const q = t[0] as string;
  for (const lei of r.targets) {
    const e = entryOf.get(lei);
    if (e === undefined) continue;
    for (const n of toCandidate(e).names) {
      if ([...n.seq, ...n.extras].some((w) => matchLevel(q, w) >= 2)) return false;
    }
  }
  return true;
};

interface Result {
  query: string;
  stratum: string;
  split: string;
  rank: number; // 1-based among all scored candidates; 0 when not scored
  cause: string;
  first: string | undefined;
  files: number[];
  pool: number;
}

const resultOf = new Map<string, Result>();
const evaluate = (r: EvalQuery): Result => {
  const tokens = queryTokens(r.query);
  const files = tokens.length === 0 ? [] : route(tokens, table);
  const pool = new Map<string, C>();
  for (const f of files) for (const c of candidates(f)) pool.set(c.id, c);
  const scored: [number, C][] = [];
  for (const c of pool.values()) {
    const s = scoreCandidate(tokens, c, weights);
    if (s !== null) scored.push([s, c]);
  }
  scored.sort(([a, x], [b, y]) => b - a || (x.id < y.id ? -1 : 1));
  const rank = scored.findIndex(([, c]) => r.targets.has(c.id)) + 1;
  let cause = "first";
  if (rank !== 1) {
    const inIndex = [...r.targets].some((lei) => filesOf.has(lei));
    const inPool = [...r.targets].some((lei) => pool.has(lei));
    if (files.length === 0) cause = "not routed";
    else if (!inIndex) cause = "not in index";
    else if (!inPool) cause = noWordMatch(r) ? "not a candidate: no word" : "not a candidate";
    else if (rank === 0) cause = "no name matches";
    else cause = "scored low";
  }
  return {
    query: r.query,
    stratum: r.stratum,
    split: r.split,
    rank,
    cause,
    first:
      scored[0] === undefined
        ? undefined
        : `${scored[0][1].entry.name} (${scored[0][1].prominence})`,
    files,
    pool: pool.size,
  };
};
for (const r of all) {
  const key = `${r.stratum}\t${r.query}\t${[...r.targets].join()}`;
  if (!resultOf.has(key)) resultOf.set(key, evaluate(r));
}
const res = (r: EvalQuery) =>
  resultOf.get(`${r.stratum}\t${r.query}\t${[...r.targets].join()}`) as Result;

const mrr = (rs: EvalQuery[]) =>
  rs.length === 0
    ? Number.NaN
    : rs.reduce((a, r) => {
        const k = res(r).rank;
        return a + (k >= 1 && k <= 10 ? 1 / k : 0);
      }, 0) / rs.length;
const s1 = (rs: EvalQuery[]) => rs.filter((r) => res(r).rank === 1).length / rs.length;

const out: Record<string, unknown> = {
  index: { files: manifest.bounds.length, entries, raw, gzip: gzipTotal },
};
const table2: Record<string, Record<string, unknown>> = {};
for (const split of ["train", "test", "all"]) {
  const inSplit = (r: EvalQuery) => split === "all" || r.split === split;
  const per: Record<string, unknown> = {};
  const mrrs = STRATA.map((s) => mrr(rows.filter((r) => r.stratum === s && inSplit(r))));
  per.objective = mrrs.reduce((a, b) => a + b, 0) / mrrs.length;
  STRATA.forEach((s, i) => {
    per[s] = mrrs[i];
  });
  const short = rows.filter((r) => inSplit(r) && isShort(r.query) && !r.stratum.startsWith("typo"));
  const acro = rows.filter((r) => inSplit(r) && r.stratum.startsWith("head") && noWordMatch(r));
  const set = acronyms.filter(inSplit);
  per.short = { n: short.length, mrr: mrr(short), s1: s1(short) };
  per.acronym = { n: acro.length, mrr: mrr(acro), s1: s1(acro) };
  per.acronymSet = { n: set.length, mrr: mrr(set), s1: s1(set) };
  table2[split] = per;
}
out.strata = table2;
// Every row's rank, for compare.ts: the evaluation set, then the acronym set, in file order.
out.rows = all.map((r) => ({
  query: r.query,
  stratum: r.stratum,
  split: r.split,
  target: [...r.targets][0],
  // The short subset: evaluation-set queries of one 2 to 4 character word, typos left out.
  short: isShort(r.query) && STRATA.includes(r.stratum) && !r.stratum.startsWith("typo"),
  rank: res(r).rank,
}));
console.log(JSON.stringify(table2, null, 1));

// Detail for the subsets.
const detail = (rs: EvalQuery[]) =>
  rs.map((r) => {
    const x = res(r);
    return `${x.split.padEnd(5)} ${x.stratum.padEnd(11)} ${JSON.stringify(x.query).padEnd(14)} rank ${String(x.rank).padStart(4)}  ${x.cause.padEnd(26)} pool ${String(x.pool).padStart(4)}  first: ${x.first ?? "-"}`;
  });
const shortRows = rows.filter((r) => isShort(r.query) && !r.stratum.startsWith("typo"));
const acroRows = rows.filter((r) => r.stratum.startsWith("head") && noWordMatch(r));
out.short = detail(shortRows);
out.acronym = detail(acroRows);
out.acronymSet = detail(acronyms);
const causes = (rs: EvalQuery[]) => {
  const c: Record<string, number> = {};
  for (const r of rs) c[res(r).cause] = (c[res(r).cause] ?? 0) + 1;
  return c;
};
out.causes = {
  short: causes(shortRows),
  acronym: causes(acroRows),
  acronymSet: causes(acronyms),
};
console.log(JSON.stringify(out.causes, null, 1));

// Bytes per query: test queries typed one key at a time, debounce on every key and last key.
if (!values["no-bytes"]) {
  const bytes: Record<string, unknown> = {};
  for (const debounce of ["every key", "last key"] as const) {
    const test = rows.filter((r) => r.split === "test");
    const kb = test.map(
      (r) =>
        [...sessionFiles(keystrokes(r.query, table), debounce)].reduce(
          (a, f) => a + (gzip[f] ?? 0),
          0,
        ) / 1024,
    );
    bytes[debounce] = summary(kb);
  }
  out.bytes = bytes;
  console.log(JSON.stringify(bytes));
}
if (values.out) writeFileSync(values.out, JSON.stringify(out, null, 1));
