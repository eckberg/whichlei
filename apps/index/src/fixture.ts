// A tiny index for tests: the files the indexer writes (index.json, build.json,
// <build>/n.txt, codes.json), small enough to build in a millisecond. No network.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, encodeEntries, type Manifest } from "@whichlei/core";

export const ACME = "ACME0000000000000001";
export const ZETA = "ZETA0000000000000001";

const entry = (lei: string, name: string, prominence: number): Entry => ({
  lei,
  name,
  otherNames: [],
  country: "SE",
  status: "I",
  prominence,
});

/** File 0 holds the terms below "m", file 1 the rest. */
export const FILES: Entry[][] = [
  [entry(ACME, "Acme Holdings", 5), entry("ACME0000000000000002", "Acme Trading", 1)],
  [entry(ZETA, "Zeta Corporation", 4)],
];

export interface TinyOptions {
  build?: string;
  asOf?: string;
  records?: number;
  /** Extra index files' worth of nothing: the number of files the manifest names. */
  files?: Entry[][];
}

/** The text of every file of a tiny build, by path relative to the index directory. */
export function tinyFiles(options: TinyOptions = {}): { path: string; content: string }[] {
  const { build = "20260916-3f9a1c0e", asOf = "2026-09-16", files = FILES } = options;
  const entities = new Set(files.flat().map((e) => e.lei)).size;
  const manifest: Manifest = {
    format: 1,
    build,
    asOf,
    entities,
    bounds: files.map((_, i) => (i === 0 ? "aaa" : `m${"0".repeat(i)}`)),
    capped: [],
  };
  return [
    { path: "index.json", content: `${JSON.stringify(manifest)}\n` },
    ...files.map((list, n) => ({ path: `${build}/${n}.txt`, content: encodeEntries(list) })),
    {
      path: `${build}/codes.json`,
      content: `${JSON.stringify({ elf: { XJHM: "Aktiebolag" }, ra: {} })}\n`,
    },
  ];
}

/** Writes a tiny build as the indexer would: also build.json, which is not part of the index. */
export function writeTinyBuild(dir: string, options: TinyOptions = {}): string {
  const { build = "20260916-3f9a1c0e", asOf = "2026-09-16", records = 4, files = FILES } = options;
  for (const { path, content } of tinyFiles(options)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const entities = new Set(files.flat().map((e) => e.lei)).size;
  const report = {
    build,
    asOf,
    records,
    entities,
    files: files.length,
    capped: 0,
    terms: 10,
    postings: 20,
    bytes: 1000,
    nowYear: 2026.7,
    stats: {},
    seconds: { entities: 1 },
    peakRssMb: 100,
  };
  writeFileSync(join(dir, "build.json"), `${JSON.stringify(report, null, 2)}\n`);
  return build;
}
