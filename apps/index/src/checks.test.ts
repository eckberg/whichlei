import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CheckRow,
  type Config,
  evaluate,
  type Inputs,
  markdownTable,
  measureBuild,
  parseConfig,
  publishedReport,
  readConfig,
  runQueries,
  textTable,
} from "./checks.ts";
import { ACME, writeTinyBuild, ZETA } from "./fixture.ts";
import type { PublishedReport } from "./report.ts";

const config: Config = readConfig(
  join(dirname(fileURLToPath(import.meta.url)), "..", "checks.json"),
);

const manifest = {
  format: 1 as const,
  build: "20260917-aaaaaaaa",
  asOf: "2026-09-17",
  entities: 3_320_000,
  bounds: ["aaa"],
  capped: [],
};
const measured = {
  manifest,
  records: 3_430_000,
  files: 6_440,
  gzipBytes: 221_000_000,
  rawBytes: 524_000_000,
  missing: [],
};
const live = {
  build: "20260916-bbbbbbbb",
  entities: 3_317_220,
  files: 6_438,
  gzipBytes: 220_600_000,
  objective: { test: 0.6515, all: 0.657 },
} as PublishedReport;
const good: QueriesOk = config.queries.map((q) => ({
  query: q.query,
  expected: q.lei,
  first: q.lei,
}));
type QueriesOk = Inputs["queries"];

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  config,
  measured,
  objective: { test: 0.6515, all: 0.657 },
  live,
  queries: good,
  ...over,
});
const failed = (rows: CheckRow[]) => rows.filter((r) => !r.ok).map((r) => r.name);

describe("thresholds", () => {
  test("checks.json parses and holds the first fixed query", () => {
    expect(config.queries.some((q) => q.query === "ericsson")).toBe(true);
    expect(config.reachability).toBe(0.96);
    expect(config.relative).toEqual({ entities: 0.03, files: 0.05, gzipBytes: 0.1 });
  });

  test("a malformed file is refused", () => {
    expect(() => parseConfig({})).toThrow(/queries/);
    expect(() => parseConfig({ ...config, queries: [{ query: "x", lei: "short" }] })).toThrow(
      /malformed/,
    );
    expect(() =>
      parseConfig({ ...config, absolute: { ...config.absolute, files: { min: 9, max: 1 } } }),
    ).toThrow(/min above max/);
    expect(() => parseConfig({ ...config, reachability: "high" })).toThrow(/reachability/);
  });
});

describe("evaluate against a live build", () => {
  test("a normal night passes", () => {
    expect(failed(evaluate(inputs()))).toEqual([]);
  });

  test("entities, files and size must stay within ±3%, ±5% and ±10%", () => {
    const at = (over: object) => failed(evaluate(inputs({ measured: { ...measured, ...over } })));
    // Records move with entities, so reachability stays at 97%.
    const entities = (factor: number) => {
      const count = Math.round(live.entities * factor);
      return at({ manifest: { ...manifest, entities: count }, records: Math.round(count / 0.97) });
    };
    expect(entities(1.029)).toEqual([]);
    expect(entities(1.031)).toEqual(["entities"]);
    expect(entities(0.969)).toEqual(["entities"]);
    expect(at({ files: Math.round(live.files * 1.049) })).toEqual([]);
    expect(at({ files: Math.round(live.files * 0.94) })).toEqual(["files"]);
    expect(at({ gzipBytes: Math.round(live.gzipBytes * 1.099) })).toEqual([]);
    expect(at({ gzipBytes: Math.round(live.gzipBytes * 1.11) })).toEqual(["gzip bytes"]);
    expect(at({ gzipBytes: Math.round(live.gzipBytes * 0.89) })).toEqual(["gzip bytes"]);
  });

  test("reachability must be at least 96%", () => {
    const at = (records: number) =>
      failed(evaluate(inputs({ measured: { ...measured, records } })));
    expect(at(3_458_000)).toEqual([]); // 96.0%
    expect(at(3_470_000)).toEqual(["reachability"]); // 95.7%
    expect(at(0)).toEqual(["reachability"]);
  });

  test("the objective may fall by 0.01 and no more", () => {
    const at = (test: number) => failed(evaluate(inputs({ objective: { test, all: test } })));
    expect(at(0.7)).toEqual([]);
    expect(at(0.6416)).toEqual([]);
    expect(at(0.6414)).toEqual(["objective"]);
    expect(failed(evaluate(inputs({ objective: undefined })))).toEqual(["objective"]);
  });

  test("a fixed query that finds another entity first, or none, fails", () => {
    const first = config.queries[0] as { query: string; lei: string };
    const wrong = [{ query: first.query, expected: first.lei, first: "ZZZZ0000000000000000" }];
    const none = [{ query: first.query, expected: first.lei, first: undefined }];
    expect(failed(evaluate(inputs({ queries: wrong })))).toEqual([`query "${first.query}"`]);
    expect(failed(evaluate(inputs({ queries: none })))).toEqual([`query "${first.query}"`]);
  });

  test("a file missing on disk fails", () => {
    const rows = evaluate(inputs({ measured: { ...measured, missing: ["x/1.txt"] } }));
    expect(failed(rows)).toEqual(["manifest", "files on disk"]);
  });

  test("--force-fail fails one check and only that one", () => {
    expect(failed(evaluate(inputs({ forceFail: true })))).toEqual(["forced failure"]);
  });
});

describe("absolute bounds and accept-change", () => {
  const tiny = {
    ...measured,
    manifest: { ...manifest, entities: 1000 },
    records: 1030,
    files: 10,
    gzipBytes: 5000,
  };
  const tinyLive = { ...live, entities: 1000, files: 10, gzipBytes: 5000 } as PublishedReport;

  test("the absolute bounds hold even when the change from the live build is small", () => {
    // Inside the relative bounds of a live build that was itself out of range.
    expect(failed(evaluate(inputs({ measured: tiny, live: tinyLive })))).toEqual([
      "entities",
      "files",
      "gzip bytes",
    ]);
  });

  test("the objective floor holds against a live build that was already below it", () => {
    const weak = { ...live, objective: { test: 0.55, all: 0.55 } } as PublishedReport;
    expect(failed(evaluate(inputs({ live: weak, objective: { test: 0.55, all: 0.55 } })))).toEqual([
      "objective",
    ]);
  });

  test("accept-change skips the relative bounds and says so", () => {
    const big = {
      ...measured,
      manifest: { ...manifest, entities: 3_600_000 },
      records: 3_700_000,
      files: 7_000,
      gzipBytes: 245_000_000,
    };
    expect(failed(evaluate(inputs({ measured: big })))).toEqual([
      "entities",
      "files",
      "gzip bytes",
    ]);
    const rows = evaluate(
      inputs({ measured: big, acceptChange: true, objective: { test: 0.63, all: 0.63 } }),
    );
    expect(failed(rows)).toEqual([]);
    expect(rows.some((r) => r.name === "accept-change")).toBe(true);
  });

  test("accept-change does not skip the absolute bounds or the floor", () => {
    const rows = evaluate(
      inputs({
        measured: tiny,
        live: tinyLive,
        acceptChange: true,
        objective: { test: 0.5, all: 0.5 },
      }),
    );
    expect(failed(rows)).toEqual(["entities", "files", "gzip bytes", "objective"]);
  });
});

describe("evaluate on a first publish", () => {
  const first = (over: Partial<Inputs> = {}) => inputs({ live: undefined, ...over });

  test("the absolute bounds apply", () => {
    expect(failed(evaluate(first()))).toEqual([]);
    const small = {
      ...measured,
      manifest: { ...manifest, entities: 1000 },
      files: 12,
      gzipBytes: 5000,
    };
    expect(failed(evaluate(first({ measured: small })))).toEqual([
      "entities",
      "files",
      "gzip bytes",
      "reachability",
    ]);
  });

  test("the objective needs the absolute floor", () => {
    expect(failed(evaluate(first({ objective: { test: 0.5, all: 0.5 } })))).toEqual(["objective"]);
    expect(failed(evaluate(first({ objective: { test: 0.63, all: 0.63 } })))).toEqual([]);
  });

  test("a live report with no numbers falls back to the absolute bounds", () => {
    const bare = { build: "20260916-bbbbbbbb" } as PublishedReport;
    expect(failed(evaluate(inputs({ live: bare })))).toEqual([]);
  });
});

describe("the table", () => {
  const rows = evaluate(inputs({ forceFail: true }));
  test("text marks failures", () => {
    const text = textTable(rows);
    expect(text).toMatch(/^ok +manifest/);
    expect(text).toMatch(/FAIL +forced failure/);
  });
  test("markdown has one row per check", () => {
    const lines = markdownTable(rows).split("\n");
    expect(lines).toHaveLength(rows.length + 2);
    expect(lines.at(-1)).toContain("**FAIL**");
  });
});

describe("a built directory", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "index-checks-"));
    writeTinyBuild(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("measures files, records and gzip bytes", () => {
    const { measured: m } = measureBuild(dir);
    expect(m.files).toBe(2);
    expect(m.records).toBe(4);
    expect(m.missing).toEqual([]);
    expect(m.gzipBytes).toBeGreaterThan(50);
  });

  test("fixed queries run against the files as the page would", () => {
    const { manifest: tiny } = measureBuild(dir);
    const results = runQueries(dir, tiny, [
      { query: "acme", lei: ACME },
      { query: "zeta corporation", lei: ZETA },
      { query: "nothingmatches", lei: ACME },
    ]);
    expect(results.map((r) => r.first)).toEqual([ACME, ZETA, undefined]);
  });

  test("the report to publish adds what was measured", () => {
    const { measured: m, build } = measureBuild(dir);
    const report = publishedReport(build, m, { test: 0.65, all: 0.66 });
    expect(report).toMatchObject({
      build: "20260916-3f9a1c0e",
      entities: 3,
      files: 2,
      records: 4,
      objective: { test: 0.65 },
    });
    expect(report.reachability).toBeCloseTo(0.75);
    expect(report.gzipBytes).toBe(m.gzipBytes);
    expect(report.seconds).toEqual({ entities: 1 });
  });

  test("a missing file is reported, not thrown", () => {
    const broken = mkdtempSync(join(tmpdir(), "index-checks-"));
    try {
      writeTinyBuild(broken);
      unlinkSync(join(broken, "20260916-3f9a1c0e", "1.txt"));
      const { measured: m } = measureBuild(broken);
      expect(m.missing.join()).toContain("1.txt");
      expect(failed(evaluate(inputs({ measured: m })))).toContain("manifest");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("an index.json that does not parse throws", () => {
    const bad = mkdtempSync(join(tmpdir(), "index-checks-"));
    try {
      writeTinyBuild(bad);
      const path = join(bad, "index.json");
      const manifestJson = JSON.parse(readFileSync(path, "utf8"));
      manifestJson.bounds = [];
      writeFileSync(path, JSON.stringify(manifestJson));
      expect(() => measureBuild(bad)).toThrow(/no bounds/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
