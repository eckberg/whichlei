// The build: golden copy and mapping files in, index directory out.
//
//   <out>/index.json          the manifest (docs/index-format.md)
//   <out>/<build>/<n>.txt     the index files
//   <out>/<build>/codes.json  names of legal forms and registration authorities
//   <out>/build.json          what this run saw and how long it took; not part of the index
//   <out>/prominence.tsv      with `dumpProminence`: full-precision prominence per LEI, for
//                             `check --reference`; not part of the index
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, encodeEntries, FORMAT_VERSION, type Manifest } from "@whichlei/core";
import { type Codes, encodeCodes, readElf, readRegistrationAuthorities } from "./codes.ts";
import { type Entities, type EntityStats, readEntities } from "./entities.ts";
import { pack } from "./pack.ts";
import { yearFraction } from "./prominence.ts";
import { readBics, readIsins, readRelationships } from "./signals.ts";
import type { Inputs } from "./sources.ts";

export interface BuildOptions {
  inputs: Inputs;
  /** The directory the index goes into. It is emptied first if it holds an earlier build. */
  out: string;
  /**
   * "Now" as a year fraction, for registration age. Default: the golden copy's date. The
   * research used 2026.74 for the 2026-09-16 copy; pass that to reproduce its numbers.
   */
  nowYear?: number;
  /** Also write prominence.tsv. */
  dumpProminence?: boolean;
  log?: (message: string) => void;
}

/** What `build.json` holds. */
export interface BuildReport {
  build: string;
  asOf: string;
  /** Rows in the level 1 golden copy. */
  records: number;
  /** Entities reachable through the index. */
  entities: number;
  files: number;
  capped: number;
  terms: number;
  postings: number;
  /** Bytes of the index files, uncompressed. */
  bytes: number;
  nowYear: number;
  stats: EntityStats;
  /** Seconds per step. */
  seconds: Record<string, number>;
  /** Peak resident memory of the process so far, in MB. */
  peakRssMb: number;
}

/** `20260916` for 2026-09-16. */
const compactDate = (asOf: string) => asOf.replaceAll("-", "");

/** Write the entities of a file, in order, as `encodeEntries` wants them. */
function* entriesOf(entities: Entities, ids: Int32Array): Generator<Entry> {
  for (const id of ids) {
    yield {
      lei: entities.lei[id] as string,
      name: entities.name[id] as string,
      otherNames: [...(entities.otherNames[id] ?? [])],
      country: entities.country[id] as string,
      status: entities.status[id] as Entities["status"][number],
      prominence: entities.prominence[id] as number,
    };
  }
}

/** Position of each LEI in sorted order. */
function leiRank(lei: readonly string[]): Int32Array {
  const order = Int32Array.from({ length: lei.length }, (_, i) => i);
  order.sort((a, b) => ((lei[a] as string) < (lei[b] as string) ? -1 : 1));
  const rank = new Int32Array(lei.length);
  order.forEach((entity, position) => {
    rank[entity] = position;
  });
  return rank;
}

/** Empty `out` if it holds an earlier build; refuse a directory that holds anything else. */
function prepare(out: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(out);
  } catch {}
  if (names.length > 0 && !names.includes("index.json")) {
    throw new Error(`${out} is not empty and holds no index.json; refusing to overwrite it`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}

export async function buildIndex(options: BuildOptions): Promise<BuildReport> {
  const { inputs, out, dumpProminence = false, log = () => {} } = options;
  const nowYear = options.nowYear ?? yearFraction(inputs.asOf);
  const seconds: Record<string, number> = {};
  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    const result = await run();
    seconds[name] = (Date.now() - started) / 1000;
    log(`${name}: ${seconds[name]?.toFixed(1)} s, rss ${peakRssMb().toFixed(0)} MB`);
    return result;
  };

  const relationships = await step("relationships", () => readRelationships(inputs.rr));
  log(
    `  ${relationships.rows.toLocaleString()} rows, ${relationships.active.toLocaleString()} active,` +
      ` ${relationships.parents.size.toLocaleString()} parents`,
  );
  const isins = await step("isins", () => readIsins(inputs.isin));
  const bics = await step("bics", () => readBics(inputs.bic));
  log(`  ${isins.size.toLocaleString()} LEIs with ISINs, ${bics.size.toLocaleString()} with a BIC`);

  const { entities, postings, stats } = await step("entities", () =>
    readEntities(inputs.lei2, { relationships, isins, bics, nowYear }, (rows) =>
      log(`  ${rows.toLocaleString()} rows, rss ${peakRssMb().toFixed(0)} MB`),
    ),
  );
  log(
    `  ${entities.count.toLocaleString()} entities, ${postings.size.toLocaleString()} postings` +
      `, ${stats.noTerms} with no index term, ${stats.unknownStatus} with an unknown status`,
  );
  if (stats.noLei > 0) log(`  WARNING: ${stats.noLei} rows without an LEI were skipped`);
  if (inputs.records !== undefined && inputs.records !== entities.count) {
    log(`  WARNING: GLEIF announced ${inputs.records} records, the file has ${entities.count}`);
  }

  const grouped = await step("group", () => postings.finish());
  // Equal prominence is ordered by LEI. The golden copy is in LEI order, so the entity number
  // does it; if a copy ever is not, rank the entities by LEI.
  const inLeiOrder = entities.lei.every(
    (lei, i) => i === 0 || (entities.lei[i - 1] as string) < lei,
  );
  const rank = inLeiOrder ? undefined : leiRank(entities.lei);
  if (rank !== undefined) log("  the golden copy is not in LEI order; ranking by LEI");
  const packing = await step("pack", () =>
    pack(grouped, entities.prominence, rank === undefined ? {} : { rank }),
  );
  log(
    `  ${grouped.words.length.toLocaleString()} terms, ${packing.files.length} files,` +
      ` ${packing.capped.length} capped, ${packing.reachable.toLocaleString()} entities reachable`,
  );

  const codes: Codes = await step("codes", () => ({
    elf: readElf(readFileSync(inputs.elf)),
    ra: readRegistrationAuthorities(readFileSync(inputs.ra)),
  }));
  log(
    `  ${Object.keys(codes.elf).length} legal forms, ${Object.keys(codes.ra).length} registration authorities`,
  );

  // Files go into a scratch directory first: the build's name depends on their content.
  prepare(out);
  const scratch = join(out, "building");
  mkdirSync(scratch);
  const hash = createHash("sha256");
  let bytes = 0;
  await step("write", () => {
    packing.files.forEach((ids, n) => {
      const text = encodeEntries(entriesOf(entities, ids));
      writeFileSync(join(scratch, `${n}.txt`), text);
      hash.update(`${n}\n${text}`);
      bytes += Buffer.byteLength(text);
    });
    const text = encodeCodes(codes);
    writeFileSync(join(scratch, "codes.json"), text);
    hash.update(`codes\n${text}`);
  });
  const build = `${compactDate(inputs.asOf)}-${hash.digest("hex").slice(0, 8)}`;
  renameSync(scratch, join(out, build));

  const manifest: Manifest = {
    format: FORMAT_VERSION,
    build,
    asOf: inputs.asOf,
    entities: packing.reachable,
    bounds: packing.bounds,
    capped: packing.capped,
  };
  writeFileSync(join(out, "index.json"), JSON.stringify(manifest));

  if (dumpProminence) {
    await step("prominence", () => {
      const lines: string[] = [];
      for (let id = 0; id < entities.count; id++) {
        const year = entities.registeredYear[id] as number;
        const age = Number.isNaN(year) ? 0 : Math.fround(Math.fround(nowYear) - year);
        lines.push(`${entities.lei[id]}\t${entities.prominence[id]}\t${age}\n`);
        if (lines.length === 100_000) {
          writeFileSync(join(out, "prominence.tsv"), lines.join(""), { flag: "a" });
          lines.length = 0;
        }
      }
      writeFileSync(join(out, "prominence.tsv"), lines.join(""), { flag: "a" });
    });
  }

  const report: BuildReport = {
    build,
    asOf: inputs.asOf,
    records: entities.count,
    entities: packing.reachable,
    files: packing.files.length,
    capped: packing.capped.length,
    terms: grouped.words.length,
    postings: grouped.entities.length,
    bytes,
    nowYear,
    stats,
    seconds,
    peakRssMb: peakRssMb(),
  };
  writeFileSync(join(out, "build.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Peak resident memory of this process, in MB (`ru_maxrss` is in KB). */
export function peakRssMb(): number {
  return process.resourceUsage().maxRSS / 1024;
}
