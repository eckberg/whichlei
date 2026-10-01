// Check a built index directory.
//
//   pnpm --filter @whichlei/indexer check dist
//   pnpm --filter @whichlei/indexer check dist --reference ../../research/data/index --eval
//
//   --reference  the research index (research/ranking/port/dump_index.py): diff the routing
//                table, capped files, every file's entities and order, and prominence
//   --eval       replay the evaluation queries and print the objective
//   --json       with --eval: write the objective to this file, for `index checks`:
//                {"objective": {"test": 0.6515, "all": 0.657}}
//   --records    entities in the golden copy, for reachability (default: from build.json)
// Exits 1 if anything is wrong.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkIndex, compareReference, IndexDir, replayEvaluation } from "../src/check.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    reference: { type: "string" },
    eval: { type: "boolean", default: false },
    json: { type: "string" },
    records: { type: "string" },
  },
});
const dir = positionals[0];
if (dir === undefined) throw new Error("usage: check <index dir> [--reference dir] [--eval]");

const started = Date.now();
const log = (message: string) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
const report = { problems: [] as string[], log };

const index = new IndexDir(dir);
const buildJson = join(dir, "build.json");
const records =
  values.records !== undefined
    ? Number(values.records)
    : existsSync(buildJson)
      ? (JSON.parse(readFileSync(buildJson, "utf8")) as { records: number }).records
      : undefined;

checkIndex(index, records, report);
if (values.reference !== undefined) await compareReference(index, values.reference, report);
if (values.json !== undefined && !values.eval) throw new Error("--json needs --eval");
if (values.eval) {
  const objective = replayEvaluation(index, log);
  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify({ objective })}\n`);
  }
}

if (report.problems.length > 0) {
  for (const problem of report.problems.slice(0, 50)) console.error(`PROBLEM: ${problem}`);
  console.error(`${report.problems.length} problems`);
  process.exit(1);
}
log("ok");
