// The report published with every build, as `<build>/report.json`. The next run compares
// its own build against it (checks.ts). Documented in docs/index-format.md.

/** The indexer's `build.json` plus what the checks measured. */
export interface PublishedReport {
  build: string;
  asOf: string;
  /** Rows in the level 1 golden copy. */
  records: number;
  /** Entities reachable through the index. */
  entities: number;
  /** Index files, `<build>/0.txt` and up. */
  files: number;
  capped: number;
  terms: number;
  postings: number;
  /** Bytes of the index files, uncompressed. */
  bytes: number;
  /** Bytes of the index files, each gzipped at level 6: what a CDN sends, near enough. */
  gzipBytes: number;
  /** `entities / records`. */
  reachability: number;
  /** The evaluation objective, replayed over the built files (`indexer check --eval`). */
  objective: { test: number; all: number };
  nowYear: number;
  seconds: Record<string, number>;
  peakRssMb: number;
  [other: string]: unknown;
}

/**
 * What `index checks` writes next to the indexer's output, as `measured.json`: whether the
 * build passed, and the report to publish. `assemble` refuses a build that did not pass.
 */
export interface Measured {
  passed: boolean;
  report: PublishedReport;
}
