// Build the index from GLEIF's files.
//
//   pnpm --filter @whichlei/indexer build --publish-date 2026-09-16 --out dist
//   pnpm --filter @whichlei/indexer build --input-dir ../../research/data --out dist
//
//   --publish-date  YYYY-MM-DD or "latest" (default). With --input-dir it only names the date
//                   of the files there; by default that comes from the file.
//   --input-dir     use the files in this directory and download nothing. It holds lei2.csv.zip,
//                   rr.csv.zip, isin-lei.zip, bic-lei.zip, elf-raw.csv and ra-list.csv, or
//                   has them in a signals/ folder, as research/data does.
//   --download-dir  where downloads go (default .inputs)
//   --out           the index directory (default dist). Emptied first if it holds an earlier build.
//   --now-year      registration age is measured to this year fraction. Default: the publish
//                   date. `--now-year 2026.74` reproduces the research's 2026-09-16 numbers.
//   --dump-prominence  also write <out>/prominence.tsv for `check --reference`
import { parseArgs } from "node:util";
import { buildIndex, peakRssMb } from "../src/build.ts";
import { downloadInputs, localInputs } from "../src/sources.ts";

const { values } = parseArgs({
  options: {
    "publish-date": { type: "string", default: "latest" },
    "input-dir": { type: "string" },
    "download-dir": { type: "string", default: ".inputs" },
    out: { type: "string", default: "dist" },
    "now-year": { type: "string" },
    "dump-prominence": { type: "boolean", default: false },
  },
});

const started = Date.now();
const log = (message: string) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s] ${message}`);

const publishDate = values["publish-date"] as string;
const inputs =
  values["input-dir"] !== undefined
    ? await localInputs(values["input-dir"], publishDate)
    : await downloadInputs(values["download-dir"] as string, publishDate, fetch, log);
log(`golden copy of ${inputs.asOf}`);

const nowYear = values["now-year"] === undefined ? undefined : Number(values["now-year"]);
if (nowYear !== undefined && !Number.isFinite(nowYear)) throw new Error("--now-year is no number");

const report = await buildIndex({
  inputs,
  out: values.out as string,
  dumpProminence: values["dump-prominence"] as boolean,
  log,
  ...(nowYear === undefined ? {} : { nowYear }),
});
log(
  `built ${report.build}: ${report.files} files, ${report.entities.toLocaleString()} of` +
    ` ${report.records.toLocaleString()} entities reachable,` +
    ` ${(report.bytes / 1e6).toFixed(0)} MB raw, peak rss ${peakRssMb().toFixed(0)} MB`,
);
