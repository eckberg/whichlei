// The blocking checks before a publish. The thresholds are in checks.json, one reviewed
// file: a legitimate big change in GLEIF's data is a commit there, not a silent pass.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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
import type { PublishedReport } from "./report.ts";

export interface Range {
  min: number;
  max: number;
}

export interface Config {
  /** Allowed change from the live build, as a fraction of the live value. */
  relative: { entities: number; files: number; gzipBytes: number };
  /** Bounds when there is no live build to compare with: the first publish. */
  absolute: { entities: Range; files: Range; gzipBytes: Range; objective: number };
  /** Entities reachable through the index, as a share of the golden copy's records. */
  reachability: number;
  /** How far the evaluation objective may fall below the live build's. */
  objectiveDrop: number;
  /** Typing `query` must put `lei` first. */
  queries: { query: string; lei: string }[];
}

function number(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`checks.json: ${what}`);
  return value;
}

function range(value: unknown, what: string): Range {
  const r = value as Partial<Range> | null;
  const out = { min: number(r?.min, `${what}.min`), max: number(r?.max, `${what}.max`) };
  if (out.min > out.max) throw new Error(`checks.json: ${what} has min above max`);
  return out;
}

export function parseConfig(json: unknown): Config {
  const c = json as Record<string, Record<string, unknown>> & { queries?: unknown };
  const queries = c.queries;
  if (!Array.isArray(queries) || queries.length === 0) throw new Error("checks.json: queries");
  return {
    relative: {
      entities: number(c.relative?.entities, "relative.entities"),
      files: number(c.relative?.files, "relative.files"),
      gzipBytes: number(c.relative?.gzipBytes, "relative.gzipBytes"),
    },
    absolute: {
      entities: range(c.absolute?.entities, "absolute.entities"),
      files: range(c.absolute?.files, "absolute.files"),
      gzipBytes: range(c.absolute?.gzipBytes, "absolute.gzipBytes"),
      objective: number(c.absolute?.objective, "absolute.objective"),
    },
    reachability: number(c.reachability, "reachability"),
    objectiveDrop: number(c.objectiveDrop, "objectiveDrop"),
    queries: queries.map((q: { query?: unknown; lei?: unknown }) => {
      if (
        typeof q.query !== "string" ||
        typeof q.lei !== "string" ||
        !/^[0-9A-Z]{20}$/.test(q.lei)
      ) {
        throw new Error(`checks.json: a query is malformed: ${JSON.stringify(q)}`);
      }
      return { query: q.query, lei: q.lei };
    }),
  };
}

export function readConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** What the built directory measures to. */
export interface Measured {
  manifest: Manifest;
  records: number;
  files: number;
  gzipBytes: number;
  rawBytes: number;
  /** Files the manifest names that are not on disk. */
  missing: string[];
}

/** Reads the build: the manifest, the build report, and every file for its gzip size. */
export function measureBuild(dir: string): {
  manifest: Manifest;
  measured: Measured;
  build: Record<string, unknown>;
} {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
  const build = JSON.parse(readFileSync(join(dir, "build.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const missing: string[] = [];
  let gzipBytes = 0;
  let rawBytes = 0;
  const names = [
    ...Array.from({ length: manifest.bounds.length }, (_, n) => filePath(manifest, n)),
    `${manifest.build}/codes.json`,
  ];
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const bytes = readFileSync(path);
    rawBytes += bytes.length;
    gzipBytes += gzipSync(bytes, { level: 6 }).length;
  }
  const onDisk = readdirSync(join(dir, manifest.build)).filter((n) => /^\d+\.txt$/.test(n)).length;
  if (onDisk !== manifest.bounds.length) {
    missing.push(`${onDisk} index files on disk, ${manifest.bounds.length} in the manifest`);
  }
  return {
    manifest,
    build,
    measured: {
      manifest,
      records: Number(build.records),
      files: manifest.bounds.length,
      gzipBytes,
      rawBytes,
      missing,
    },
  };
}

export interface QueryResult {
  query: string;
  expected: string;
  /** The LEI the page would show first, if any. */
  first: string | undefined;
}

/** Types each query as a finished word and takes the first result, as the page does. */
export function runQueries(
  dir: string,
  manifest: Manifest,
  queries: Config["queries"],
): QueryResult[] {
  const table = routingTable(manifest);
  const cache = new Map<number, Entry[]>();
  const entries = (file: number) => {
    let list = cache.get(file);
    if (list === undefined) {
      list = decodeEntries(readFileSync(join(dir, filePath(manifest, file)), "utf8"));
      cache.set(file, list);
    }
    return list;
  };
  return queries.map(({ query, lei }) => {
    const tokens = queryTokens(query);
    const pool = new Map<string, ReturnType<typeof toCandidate>>();
    for (const file of route(tokens, table)) {
      for (const entry of entries(file)) pool.set(entry.lei, toCandidate(entry));
    }
    return { query, expected: lei, first: topK(tokens, pool.values(), 1)[0]?.id };
  });
}

export interface CheckRow {
  name: string;
  value: string;
  limit: string;
  ok: boolean;
}

export interface Inputs {
  config: Config;
  measured: Measured;
  /** The evaluation objective, from `indexer check --eval --json`; undefined if not given. */
  objective: { test: number; all: number } | undefined;
  /** The live build's report; undefined on a first publish. */
  live: PublishedReport | undefined;
  queries: QueryResult[];
  /** Makes one check fail, to prove a failing check publishes nothing. */
  forceFail?: boolean;
  /** Skip the bounds relative to the live build, for this run only. The absolute ones apply. */
  acceptChange?: boolean;
}

const n = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number) => `${(100 * value).toFixed(2)}%`;

/**
 * The absolute bounds always hold. With a live value, the change from it must also stay
 * within `tolerance`, unless the change is accepted for this run.
 */
function bounded(
  name: string,
  value: number,
  live: number | undefined,
  tolerance: number,
  absolute: Range,
  acceptChange: boolean,
): CheckRow {
  const limits = [`${n(absolute.min)} to ${n(absolute.max)}`];
  let ok = value >= absolute.min && value <= absolute.max;
  if (live !== undefined && Number.isFinite(live) && live > 0 && !acceptChange) {
    const min = live * (1 - tolerance);
    const max = live * (1 + tolerance);
    limits.push(`${n(min)} to ${n(max)} (live ${n(live)} ± ${(100 * tolerance).toFixed(0)}%)`);
    ok = ok && value >= min && value <= max;
  }
  return { name, value: n(value), limit: limits.join("; "), ok };
}

/** Every blocking check, as a table row. Pure: all inputs are in `inputs`. */
export function evaluate(inputs: Inputs): CheckRow[] {
  const { config, measured, objective, live, queries } = inputs;
  const acceptChange = inputs.acceptChange === true;
  const rows: CheckRow[] = [];
  const { manifest } = measured;
  rows.push({
    name: "manifest",
    value: `build ${manifest.build}, golden copy ${manifest.asOf}`,
    limit: "parses; every file is on disk",
    ok: measured.missing.length === 0,
  });
  if (measured.missing.length > 0) {
    rows.push({
      name: "files on disk",
      value: measured.missing.slice(0, 3).join("; "),
      limit: "none missing",
      ok: false,
    });
  }
  rows.push(
    bounded(
      "entities",
      manifest.entities,
      live?.entities,
      config.relative.entities,
      config.absolute.entities,
      acceptChange,
    ),
  );
  rows.push(
    bounded(
      "files",
      measured.files,
      live?.files,
      config.relative.files,
      config.absolute.files,
      acceptChange,
    ),
  );
  rows.push(
    bounded(
      "gzip bytes",
      measured.gzipBytes,
      live?.gzipBytes,
      config.relative.gzipBytes,
      config.absolute.gzipBytes,
      acceptChange,
    ),
  );

  const reach = measured.records > 0 ? manifest.entities / measured.records : 0;
  rows.push({
    name: "reachability",
    value: `${pct(reach)} of ${n(measured.records)} records`,
    limit: `at least ${pct(config.reachability)}`,
    ok: reach >= config.reachability,
  });

  const liveObjective = live?.objective?.test;
  if (objective === undefined) {
    rows.push({
      name: "objective",
      value: "not measured",
      limit: "run indexer check --eval --json",
      ok: false,
    });
  } else {
    const limits = [`at least ${config.absolute.objective.toFixed(4)}`];
    let ok = objective.test >= config.absolute.objective;
    if (liveObjective !== undefined && Number.isFinite(liveObjective) && !acceptChange) {
      const floor = liveObjective - config.objectiveDrop;
      limits.push(
        `at least ${floor.toFixed(4)} (live ${liveObjective.toFixed(4)} - ${config.objectiveDrop})`,
      );
      ok = ok && objective.test >= floor;
    }
    rows.push({
      name: "objective",
      value: objective.test.toFixed(4),
      limit: limits.join("; "),
      ok,
    });
  }

  for (const { query, expected, first } of queries) {
    rows.push({
      name: `query "${query}"`,
      value: first ?? "no result",
      limit: `${expected} first`,
      ok: first === expected,
    });
  }
  if (acceptChange) {
    rows.push({
      name: "accept-change",
      value: "relative bounds skipped for this run",
      limit: "absolute bounds still apply",
      ok: true,
    });
  }
  if (inputs.forceFail) {
    rows.push({ name: "forced failure", value: "--force-fail", limit: "never", ok: false });
  }
  return rows;
}

const plainCell = (text: string) => text.replaceAll("|", "\\|");

export function textTable(rows: readonly CheckRow[]): string {
  const cells = rows.map((r) => [r.ok ? "ok" : "FAIL", r.name, r.value, r.limit]);
  const widths = [0, 1, 2, 3].map((i) =>
    Math.max(...cells.map((row) => (row[i] as string).length)),
  );
  return cells
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] as number))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function markdownTable(rows: readonly CheckRow[]): string {
  return [
    "| | check | value | limit |",
    "|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.ok ? "ok" : "**FAIL**"} | ${plainCell(r.name)} | ${plainCell(r.value)} | ${plainCell(r.limit)} |`,
    ),
  ].join("\n");
}

/** The report to publish: the build's report plus what was measured here. */
export function publishedReport(
  build: Record<string, unknown>,
  measured: Measured,
  objective: { test: number; all: number },
): PublishedReport {
  const { manifest } = measured;
  return {
    ...(build as Omit<PublishedReport, "gzipBytes" | "reachability" | "objective">),
    build: manifest.build,
    asOf: manifest.asOf,
    entities: manifest.entities,
    files: measured.files,
    gzipBytes: measured.gzipBytes,
    reachability: manifest.entities / measured.records,
    objective,
  } as PublishedReport;
}
