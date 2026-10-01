// Checks on a built index directory: is it whole, how big is it, does it match the research
// index, and how well does it answer the evaluation queries.
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";
import { type EvalQuery, loadEval, objective, summary } from "@whichlei/bench/evaluation";
import {
  decodeEntries,
  type Entry,
  filePath,
  type Manifest,
  parseManifest,
  queryTokens,
  route,
  routingTable,
  toCandidate,
  topK,
} from "@whichlei/core";
import { CAP } from "./pack.ts";

export interface Report {
  /** What is wrong, one line each. Empty if the index passed. */
  problems: string[];
  log: (message: string) => void;
}

const KB = 1024;

/** An index directory, read file by file. */
export class IndexDir {
  readonly dir: string;
  readonly manifest: Manifest;
  constructor(dir: string) {
    this.dir = dir;
    this.manifest = parseManifest(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
  }

  get fileCount(): number {
    return this.manifest.bounds.length;
  }

  path(file: number): string {
    return join(this.dir, filePath(this.manifest, file));
  }

  read(file: number): Buffer {
    return readFileSync(this.path(file));
  }

  entries(file: number): Entry[] {
    return decodeEntries(this.read(file).toString("utf8"));
  }
}

/**
 * The index is whole: the manifest is valid, every file is there, each decodes, is ordered
 * and within the cap, and the entities reachable through the files are the manifest's count.
 * Reports sizes (gzip level 6 stands in for what the CDN sends) and reachability.
 */
export function checkIndex(index: IndexDir, records: number | undefined, report: Report): void {
  const { manifest } = index;
  const { problems, log } = report;
  // parseManifest has already checked the manifest: format, build, bounds and capped.
  const { bounds, capped } = manifest;

  const present = readdirSync(join(index.dir, manifest.build)).filter((n) => /^\d+\.txt$/.test(n));
  if (present.length !== bounds.length) {
    problems.push(`${present.length} index files on disk, ${bounds.length} in the manifest`);
  }

  const seen = new Set<string>();
  const gzip: number[] = [];
  let raw = 0;
  let entries = 0;
  const cappedSet = new Set(capped);
  for (let n = 0; n < index.fileCount; n++) {
    if (!existsSync(index.path(n))) {
      problems.push(`file ${n} is missing`);
      continue;
    }
    const buffer = index.read(n);
    raw += buffer.length;
    gzip.push(gzipSync(buffer, { level: 6 }).length);
    let list: Entry[];
    try {
      list = decodeEntries(buffer.toString("utf8"));
    } catch (error) {
      problems.push(`file ${n} does not decode: ${(error as Error).message}`);
      continue;
    }
    entries += list.length;
    if (list.length === 0) problems.push(`file ${n} is empty`);
    if (list.length > CAP) problems.push(`file ${n} has ${list.length} entries, over ${CAP}`);
    // Capped means cut to the cap. A file that holds exactly the cap was not cut.
    if (cappedSet.has(n) && list.length !== CAP) {
      problems.push(`file ${n} is capped and has ${list.length} entries, not ${CAP}`);
    }
    list.forEach((e, i) => {
      seen.add(e.lei);
      const prev = list[i - 1];
      // Lines go by full-precision prominence, which the file does not hold: within one
      // stored value only the reference can tell the order.
      if (prev !== undefined && prev.prominence < e.prominence) {
        problems.push(`file ${n} is out of order at ${e.lei}`);
      }
    });
  }
  if (seen.size !== manifest.entities) {
    problems.push(`the files hold ${seen.size} entities, the manifest says ${manifest.entities}`);
  }

  const kb = summary(gzip.map((bytes) => bytes / KB));
  const total = gzip.reduce((a, b) => a + b, 0);
  log(`build ${manifest.build}, golden copy ${manifest.asOf}`);
  log(`files: ${index.fileCount} (${capped.length} capped), ${entries.toLocaleString()} entries`);
  log(
    `size: ${(raw / 1e6).toFixed(1)} MB raw, ${(total / 1e6).toFixed(1)} MB gzip;` +
      ` per file gzip median ${kb.median.toFixed(1)} KB, p90 ${kb.p90.toFixed(1)} KB,` +
      ` max ${kb.max.toFixed(1)} KB`,
  );
  const reach =
    records === undefined
      ? "reachability: records unknown (no build.json, no --records)"
      : `reachability: ${seen.size.toLocaleString()} of ${records.toLocaleString()} records,` +
        ` ${((100 * seen.size) / records).toFixed(2)}%`;
  log(`entities: ${seen.size.toLocaleString()} reachable; ${reach}`);
  if (existsSync(join(index.dir, manifest.build, "codes.json"))) {
    const codes = JSON.parse(
      readFileSync(join(index.dir, manifest.build, "codes.json"), "utf8"),
    ) as {
      elf: object;
      ra?: object;
    };
    log(
      `codes.json: ${Object.keys(codes.elf).length} legal forms, ${Object.keys(codes.ra ?? {}).length} registration authorities`,
    );
  } else {
    problems.push("codes.json is missing");
  }
}

// ---- Against the research index -------------------------------------------------------

interface Reference {
  /** LEI of each entity number. */
  lei: Map<number, string>;
  /** Everything after the prominence in the reference's line: country, status, names. */
  rest: Map<string, string>;
  p: Map<string, number>;
  age: Map<string, number>;
}

async function* lines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (line !== "") yield line;
  }
}

async function loadReference(dir: string): Promise<Reference> {
  const ref: Reference = { lei: new Map(), rest: new Map(), p: new Map(), age: new Map() };
  for await (const line of lines(join(dir, "entities.tsv"))) {
    // id, lei, country, status, P, age, names...
    const f = line.split("\t");
    const lei = f[1] as string;
    ref.lei.set(Number(f[0]), lei);
    ref.rest.set(lei, [f[2], f[3], ...f.slice(6)].join("\t"));
    ref.p.set(lei, Number(f[4]));
    ref.age.set(lei, Number(f[5]));
  }
  return ref;
}

/** Two prominences this close are the same to the float32 arithmetic the research used. */
const TIE = 1e-6;

/**
 * A file that differs from the reference only where entities swap places and each swapped
 * pair has prominence within TIE: the same entities, order differing by float32 noise.
 */
function onlyTies(
  got: readonly Entry[],
  want: readonly string[],
  prominence: ReadonlyMap<string, number>,
): boolean {
  if (got.length !== want.length) return false;
  if ([...got.map((e) => e.lei)].sort().join() !== [...want].sort().join()) return false;
  return got.every((e, i) => {
    const there = want[i] as string;
    if (e.lei === there) return true;
    const a = prominence.get(e.lei);
    const b = prominence.get(there);
    return a !== undefined && b !== undefined && Math.abs(a - b) <= TIE;
  });
}

/**
 * Compare with the research index in `referenceDir` (research/ranking/port/dump_index.py):
 * the routing table, the capped files, every file's entities in order, the data of every
 * entity, and prominence rounded to tenths as it sits in the files. Full precision needs
 * prominence.tsv from `build --dump-prominence`. Entities whose prominence differs from
 * the reference's by under 1e-6 may swap places (float32 noise); a file that differs only
 * by such swaps is reported, not counted as a problem.
 */
export async function compareReference(
  index: IndexDir,
  referenceDir: string,
  report: Report,
): Promise<void> {
  const { problems, log } = report;
  const ref = await loadReference(referenceDir);
  const refFiles = readFileSync(join(referenceDir, "files.tsv"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [bound = "", capped = "", ids = ""] = line.split("\t");
      return { bound, capped: capped === "1", ids: ids === "" ? [] : ids.split(" ").map(Number) };
    });
  log(`reference: ${refFiles.length} files, ${ref.lei.size.toLocaleString()} entities`);

  const { bounds, capped } = index.manifest;
  const boundDiffs = refFiles.filter((f, i) => f.bound !== bounds[i]).length;
  const refCapped = refFiles.flatMap((f, i) => (f.capped ? [i] : []));
  const cappedDiffs = refCapped.join() === capped.join() ? 0 : 1;
  log(
    `bounds: ${bounds.length} vs ${refFiles.length}, ${boundDiffs} differ;` +
      ` capped: ${capped.length} vs ${refCapped.length}${cappedDiffs === 0 ? ", same" : ", DIFFERENT"}`,
  );
  if (bounds.length !== refFiles.length || boundDiffs > 0) problems.push("bounds differ");
  if (cappedDiffs > 0) problems.push("capped files differ");

  let fileDiffs = 0;
  let tieFiles = 0;
  let tiePositions = 0;
  let entryDiffs = 0;
  let dataDiffs = 0;
  let tenthsDiffs = 0;
  const examples: string[] = [];
  for (let n = 0; n < Math.min(index.fileCount, refFiles.length); n++) {
    const got = index.entries(n);
    const want = (refFiles[n]?.ids ?? []).map((id) => ref.lei.get(id) ?? `?${id}`);
    let moved = 0;
    got.forEach((e, i) => {
      if (e.lei !== want[i]) moved++;
      const data = [e.country, e.status, e.name, ...e.otherNames].join("\t");
      if (data !== ref.rest.get(e.lei)) {
        dataDiffs++;
        if (examples.length < 10) examples.push(`${e.lei}: ${data} | ${ref.rest.get(e.lei)}`);
      }
      const p = ref.p.get(e.lei);
      if (p !== undefined && Math.round(p * 10) !== Math.round(e.prominence * 10)) tenthsDiffs++;
    });
    if (got.length !== want.length) moved = Math.max(moved, 1);
    if (moved === 0) continue;
    if (onlyTies(got, want, ref.p)) {
      tieFiles++;
      tiePositions += moved;
    } else {
      fileDiffs++;
      entryDiffs += moved;
    }
  }
  if (tieFiles > 0) {
    log(
      `files: ${tieFiles} differ only by order within ${TIE} of prominence (${tiePositions}` +
        " positions): expected, numpy's float32 ln(name length) differs from Math.log in the last bit",
    );
  }
  log(
    `files: ${fileDiffs} differ in which entities they hold or in what order` +
      ` (${entryDiffs} positions); ${dataDiffs} entries differ in country, status or names;` +
      ` ${tenthsDiffs} entries differ in prominence tenths`,
  );
  for (const example of examples) log(`  ${example}`);
  if (fileDiffs > 0) problems.push(`${fileDiffs} files differ from the reference`);
  if (dataDiffs > 0) problems.push(`${dataDiffs} entries differ from the reference`);

  const dump = join(index.dir, "prominence.tsv");
  if (!existsSync(dump)) {
    log("prominence.tsv is missing: full-precision comparison skipped (build --dump-prominence)");
    return;
  }
  let compared = 0;
  let over = 0;
  let ageOver = 0;
  let maxDiff = 0;
  let maxAge = 0;
  const flips: string[] = [];
  let tenthsFlips = 0;
  for await (const line of lines(dump)) {
    const [lei = "", p = "", age = ""] = line.split("\t");
    const want = ref.p.get(lei);
    if (want === undefined) continue; // not reachable in the reference
    compared++;
    const diff = Math.abs(Number(p) - want);
    maxDiff = Math.max(maxDiff, diff);
    if (diff > 1e-6) over++;
    const ageDiff = Math.abs(Number(age) - (ref.age.get(lei) as number));
    maxAge = Math.max(maxAge, ageDiff);
    if (ageDiff > 1e-6) ageOver++;
    if (Math.round(Number(p) * 10) !== Math.round(want * 10)) {
      tenthsFlips++;
      if (flips.length < 10) flips.push(`${lei}: ${p} vs ${want}`);
    }
  }
  log(
    `prominence: ${compared.toLocaleString()} entities compared, ${over} differ by more than 1e-6` +
      ` (largest ${maxDiff.toExponential(2)}); registration age: ${ageOver} differ by more than 1e-6` +
      ` (largest ${maxAge.toExponential(2)}); ${tenthsFlips} round to a different tenth`,
  );
  for (const flip of flips) log(`  ${flip}`);
  if (compared !== ref.p.size) problems.push(`prominence.tsv covers ${compared} of ${ref.p.size}`);
  if (over > 0) problems.push(`${over} entities differ in prominence by more than 1e-6`);
}

// ---- Evaluation -----------------------------------------------------------------------

/**
 * Replay the evaluation queries over the built files, as search would: route the typed
 * query, fetch the files, merge by LEI, score, take the top 10. Returns the objective on
 * the test half and on all queries.
 */
export function replayEvaluation(
  index: IndexDir,
  log: (message: string) => void,
  queries: EvalQuery[] = loadEval(),
): { test: number; all: number } {
  const table = routingTable(index.manifest);
  // Parsed and tokenised files, most recently used last.
  const cache = new Map<number, ReturnType<typeof toCandidate>[]>();
  const candidates = (file: number) => {
    let list = cache.get(file);
    if (list === undefined) {
      list = index.entries(file).map(toCandidate);
      if (cache.size >= 200) cache.delete(cache.keys().next().value as number);
    } else {
      cache.delete(file);
    }
    cache.set(file, list);
    return list;
  };
  const top = new Map<string, string[]>();
  for (const { query } of queries) {
    if (top.has(query)) continue;
    const tokens = queryTokens(query);
    if (tokens.length === 0) {
      top.set(query, []);
      continue;
    }
    const pool = new Map<string, ReturnType<typeof toCandidate>>();
    for (const file of route(tokens, table)) {
      for (const c of candidates(file)) pool.set(c.id, c);
    }
    top.set(
      query,
      topK(tokens, pool.values()).map((c) => c.id),
    );
  }
  const result = {
    test: objective(
      queries.filter((q) => q.split === "test"),
      top,
    ),
    all: objective(queries, top),
  };
  log(
    `evaluation: ${top.size} queries, objective ${result.test.toFixed(4)} on the test half` +
      ` (${queries.filter((q) => q.split === "test").length} rows), ${result.all.toFixed(4)} on all`,
  );
  return result;
}
