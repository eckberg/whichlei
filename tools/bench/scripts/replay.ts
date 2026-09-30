// Replay every evaluation query keystroke by keystroke over the built index: bytes fetched
// per query for each encoding, and what rounding prominence does to the top 10.
//
//   pnpm --filter @whichlei/bench replay
//
// Needs build.ts's output and $DATA_DIR/parity/cases_all.json (port/dump_parity.py).
// Writes $DATA_DIR/format/replay.json and top10.json (the browser harness checks against it).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Candidate,
  type NameTokens,
  nameTokens,
  parseManifest,
  queryTokens,
  roundProminence,
  route,
  routingTable,
  topK,
} from "@whichlei/core";
import { keystrokes, sessionFiles } from "../src/session.ts";
import {
  DATA_DIR,
  type EvalQuery,
  loadEntities,
  loadEval,
  loadFiles,
  OUT_DIR,
  type RefEntity,
  summary,
} from "./data.ts";

const KB = 1024;
const log = (...args: unknown[]) =>
  console.log(`[${process.uptime().toFixed(0).padStart(4)}s]`, ...args);
const fmt = (s: { median: number; p90: number; max: number }, digits = 0) =>
  `${s.median.toFixed(digits)} / ${s.p90.toFixed(digits)} / ${s.max.toFixed(digits)}`;

interface Sizes {
  sizes: Record<string, { raw: number[]; gzip: number[]; brotli: number[] }>;
}
const { sizes } = JSON.parse(readFileSync(join(OUT_DIR, "sizes.json"), "utf8")) as Sizes;
const manifest = parseManifest(JSON.parse(readFileSync(join(OUT_DIR, "lines/index.json"), "utf8")));
const table = routingTable(manifest);
const rows = loadEval();
const splits: Record<string, EvalQuery[]> = {
  test: rows.filter((r) => r.split === "test"),
  all: rows,
};
const out: Record<string, unknown> = {};

// ---- Bytes and files per query --------------------------------------------------------
const files = loadFiles();
const strokesOf = new Map(
  [...new Set(rows.map((r) => r.query))].map((q) => [q, keystrokes(q, table)]),
);
for (const [split, queries] of Object.entries(splits)) {
  for (const debounce of ["every key", "last key"] as const) {
    const sessions = queries.map((r) => sessionFiles(strokesOf.get(r.query) ?? [], debounce));
    const result: Record<string, unknown> = {
      files: summary(sessions.map((s) => s.size)),
      entries: summary(
        queries.map((r) =>
          Math.max(
            0,
            ...(strokesOf.get(r.query) ?? []).map((s) => {
              const routed = debounce === "every key" || s.last ? s.paused : s.typing;
              return new Set(routed.flatMap((f) => files[f]?.ids ?? [])).size;
            }),
          ),
        ),
      ),
    };
    log(`${split} (${queries.length} queries), debounce fires on ${debounce}:`);
    log(
      `  files ${fmt(result.files as ReturnType<typeof summary>)}, candidates at the worst keystroke ${fmt(result.entries as ReturnType<typeof summary>)}`,
    );
    for (const [name, s] of Object.entries(sizes)) {
      for (const codec of ["gzip", "brotli"] as const) {
        const kb = summary(
          sessions.map((set) => [...set].reduce((a, f) => a + (s[codec][f] ?? 0), 0) / KB),
        );
        result[`${name} ${codec}`] = kb;
        log(`  ${name.padEnd(14)} ${codec.padEnd(6)} KB ${fmt(kb)}`);
      }
    }
    out[`${split}, ${debounce}`] = result;
  }
}

// ---- Top 10: full-precision prominence (must equal the reference) and rounded ----------
const entities = await loadEntities();
log(`${entities.size} entities loaded`);
interface Cases {
  queries: { q: string; top: number[] }[];
}
const cases = JSON.parse(readFileSync(join(DATA_DIR, "parity/cases_all.json"), "utf8")) as Cases;
const leiOf = (id: number) => (entities.get(id) as RefEntity).entry.lei;
const reference = new Map(cases.queries.map(({ q, top }) => [q, top.map(leiOf)]));

const names = new Map<number, NameTokens[]>();
const namesOf = (e: RefEntity) => {
  let n = names.get(e.id);
  if (!n) {
    n = [e.entry.name, ...e.entry.otherNames].map(nameTokens);
    names.set(e.id, n);
  }
  return n;
};
const precisions: Record<string, (p: number) => number> = {
  full: (p) => p,
  "1/100": (p) => Math.round(p * 100) / 100,
  "1/10": roundProminence,
  "1": (p) => Math.round(p),
};
const tops: Record<string, Map<string, string[]>> = {};
for (const precision of Object.keys(precisions)) tops[precision] = new Map();
for (const q of reference.keys()) {
  const tokens = queryTokens(q);
  const ids = new Set(route(tokens, table).flatMap((f) => files[f]?.ids ?? []));
  const pool = [...ids].map((id) => entities.get(id) as RefEntity);
  for (const [precision, round] of Object.entries(precisions)) {
    const candidates: Candidate<string>[] = pool.map((e) => ({
      id: e.entry.lei,
      prominence: round(e.p),
      names: namesOf(e),
    }));
    tops[precision]?.set(q, tokens.length === 0 ? [] : topK(tokens, candidates).map((c) => c.id));
  }
}

const STRATA = ["head_label", "head_alias", "torso", "tail", "typo_first3", "typo_later"];
/** Mean over the six strata of MRR@10, as evaluate.objective. */
function objective(queries: EvalQuery[], top: Map<string, string[]>): number {
  const mrr = STRATA.map((stratum) => {
    const rs = queries.filter((r) => r.stratum === stratum);
    const sum = rs.reduce((a, r) => {
      const rank = (top.get(r.query) ?? []).findIndex((lei) => r.targets.has(lei));
      return a + (rank < 0 ? 0 : 1 / (rank + 1));
    }, 0);
    return sum / rs.length;
  });
  return mrr.reduce((a, b) => a + b, 0) / mrr.length;
}
const quality: Record<string, unknown> = {};
for (const [precision, top] of Object.entries(tops)) {
  let differ = 0;
  let firstDiffers = 0;
  for (const [q, ref] of reference) {
    const got = top.get(q) ?? [];
    if (got.join() !== ref.join()) differ++;
    if (got[0] !== ref[0]) firstDiffers++;
  }
  const obj = { test: objective(splits.test ?? [], top), all: objective(rows, top) };
  quality[precision] = { differ, firstDiffers, objective: obj };
  log(
    `prominence ${precision.padEnd(5)}: top 10 differs from the reference for ${differ}/${reference.size} queries` +
      ` (first result ${firstDiffers}); objective test ${obj.test.toFixed(4)}, all ${obj.all.toFixed(4)}`,
  );
}
out.quality = quality;

writeFileSync(join(OUT_DIR, "replay.json"), JSON.stringify(out, null, 1));
writeFileSync(join(OUT_DIR, "top10.json"), JSON.stringify(Object.fromEntries(tops["1/10"] ?? [])));
log("wrote replay.json and top10.json");
