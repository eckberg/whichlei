// The blocking checks before a publish. Exits 1 if any fails; then nothing is published.
//
//   pnpm --filter @whichlei/index checks --build ../indexer/dist --eval eval.json \
//     --live https://whichlei-index.lumenspring.workers.dev
//
//   --build       the indexer's output directory
//   --eval        the JSON `indexer check --eval --json` wrote: the evaluation objective
//   --live        origin of the live index, to compare with its report. Without it, or if
//                 there is no live index yet, the absolute bounds in checks.json apply.
//   --config      thresholds, default checks.json
//   --markdown    append the table to this file (the job summary)
//   --accept-change  skip the bounds relative to the live build, for this run only. The
//                 absolute bounds in checks.json, the objective floor included, still apply.
//   --force-fail  make one check fail, to prove that a failing check publishes nothing
//
// Writes <build>/measured.json, which `assemble` needs. It says whether the build passed.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type CheckRow,
  evaluate,
  markdownTable,
  measureBuild,
  publishedReport,
  readConfig,
  runQueries,
  textTable,
} from "../src/checks.ts";
import { liveManifest, liveReport, realHttp } from "../src/live.ts";
import type { PublishedReport } from "../src/report.ts";

const { values } = parseArgs({
  options: {
    build: { type: "string" },
    eval: { type: "string" },
    live: { type: "string" },
    config: { type: "string" },
    markdown: { type: "string" },
    "accept-change": { type: "boolean", default: false },
    "force-fail": { type: "boolean", default: false },
  },
});
const dir = values.build;
if (dir === undefined) throw new Error("usage: checks --build <dir> [--eval f] [--live origin]");

const log = (message: string) => console.log(message);
const here = dirname(fileURLToPath(import.meta.url));
const config = readConfig(values.config ?? join(here, "..", "checks.json"));

const finish = (rows: CheckRow[], passed: boolean): never => {
  console.log(textTable(rows));
  if (values.markdown !== undefined) {
    appendFileSync(values.markdown, `### Checks\n\n${markdownTable(rows)}\n\n`);
  }
  console.log(passed ? "all checks passed" : "CHECKS FAILED: nothing will be published");
  process.exit(passed ? 0 : 1);
};

let built: ReturnType<typeof measureBuild>;
try {
  console.log("measuring the build (reads every file once)");
  built = measureBuild(dir);
} catch (error) {
  writeFileSync(join(dir, "measured.json"), `${JSON.stringify({ passed: false })}\n`);
  finish(
    [{ name: "manifest", value: (error as Error).message, limit: "parses", ok: false }],
    false,
  );
  throw error;
}
const { manifest, measured, build } = built;

const objective =
  values.eval === undefined
    ? undefined
    : (
        JSON.parse(readFileSync(values.eval, "utf8")) as {
          objective?: { test: number; all: number };
        }
      ).objective;

const http = realHttp(log);
let live: PublishedReport | undefined;
if (values.live !== undefined) {
  const liveBuild = await liveManifest(http, values.live);
  if (liveBuild === undefined) log("no live index: the absolute bounds apply");
  else {
    live = await liveReport(http, values.live, liveBuild.build);
    log(
      live === undefined
        ? `live build ${liveBuild.build} has no report: the absolute bounds apply`
        : `comparing with live build ${live.build} (golden copy ${live.asOf})`,
    );
  }
}

const rows = evaluate({
  config,
  measured,
  objective,
  live,
  queries: runQueries(dir, manifest, config.queries),
  forceFail: values["force-fail"],
  acceptChange: values["accept-change"],
});
const passed = rows.every((r) => r.ok);
writeFileSync(
  join(dir, "measured.json"),
  `${JSON.stringify(
    passed && objective !== undefined
      ? { passed, report: publishedReport(build, measured, objective) }
      : { passed: false },
  )}\n`,
);
finish(rows, passed);
