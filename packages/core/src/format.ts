// The static index: a manifest with the routing table, and one text file per index file.
// The contract between the indexer (slice 5), publishing (slice 6) and search (slice 7).
// docs/index-format.md describes it; docs/specs/04-index-format.md says why.
import type { RoutingTable } from "./route.ts";
import type { Candidate } from "./score.ts";
import { nameTokens } from "./tokens.ts";

/** Bumped on any change a reader of the previous version cannot parse. */
export const FORMAT_VERSION = 1;

/**
 * Registration status, lower case when the entity status is INACTIVE: I issued, L lapsed,
 * T pending transfer, P pending archival, R retired, D duplicate, A annulled, M merged.
 */
export type Status =
  | "I"
  | "L"
  | "T"
  | "P"
  | "R"
  | "D"
  | "A"
  | "M"
  | Lowercase<"I" | "L" | "T" | "P" | "R" | "D" | "A" | "M">;

const STATUS = /^[ILTPRDAM]$/i;

/** One entity in an index file: what the result list shows, and what ranking needs. */
export interface Entry {
  lei: string;
  /** Legal name, as GLEIF has it. */
  name: string;
  /** Trading, alternative-language and transliterated names. Matched, shown when they match. */
  otherNames: string[];
  /** ISO 3166-1 alpha-2 country of the legal address. */
  country: string;
  status: Status;
  /** Prominence, rounded to PROMINENCE_STEP. */
  prominence: number;
}

/** Prominence is stored as an integer count of this step. */
export const PROMINENCE_STEP = 0.1;
const PROMINENCE_SCALE = Math.round(1 / PROMINENCE_STEP);

/** Round prominence the way the index stores it. */
export function roundProminence(prominence: number): number {
  return Math.round(prominence * PROMINENCE_SCALE) / PROMINENCE_SCALE;
}

/** Tabs and line breaks separate fields and entries, so names cannot hold them. */
function clean(name: string): string {
  return name.replace(/[\t\n\r]/g, " ");
}

/**
 * One index file: one line per entry, fields separated by tabs.
 *   lei, prominence (integer count of PROMINENCE_STEP), country, status, legal name, other names...
 */
export function encodeEntries(entries: Iterable<Entry>): string {
  let out = "";
  for (const e of entries) {
    const fields = [
      e.lei,
      String(Math.round(e.prominence * PROMINENCE_SCALE)),
      e.country,
      e.status,
      clean(e.name),
      ...e.otherNames.map(clean),
    ];
    out += `${fields.join("\t")}\n`;
  }
  return out;
}

export function decodeEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const [lei, prominence, country, status, name, ...otherNames] = text
      .slice(start, end)
      .split("\t");
    if (
      lei === undefined ||
      prominence === undefined ||
      country === undefined ||
      status === undefined ||
      name === undefined ||
      !STATUS.test(status)
    ) {
      throw new Error(`malformed index entry at offset ${start}`);
    }
    entries.push({
      lei,
      name,
      otherNames,
      country,
      status: status as Status,
      prominence: Number(prominence) / PROMINENCE_SCALE,
    });
    start = end + 1;
  }
  return entries;
}

/** An entry ready for scoring: its names tokenised, the LEI as id. */
export function toCandidate(entry: Entry): Candidate<string> & { entry: Entry } {
  return {
    id: entry.lei,
    prominence: entry.prominence,
    names: [entry.name, ...entry.otherNames].map(nameTokens),
    entry,
  };
}

/**
 * `index.json`, the one mutable file. It names the build, whose files never change, and
 * carries the routing table, so the two cannot disagree.
 */
export interface Manifest {
  format: typeof FORMAT_VERSION;
  /** Directory of this build's files. Unique per build. */
  build: string;
  /** Publish date of the GLEIF golden copy, YYYY-MM-DD. */
  asOf: string;
  /** Entities reachable through the index. */
  entities: number;
  /** First term of each index file, sorted. */
  bounds: string[];
  /** Files cut to the highest-prominence entries, ascending. */
  capped: number[];
}

/** Path of index file `file`, relative to the manifest. */
export function filePath(manifest: Pick<Manifest, "build">, file: number): string {
  return `${manifest.build}/${file}.txt`;
}

export function routingTable(manifest: Pick<Manifest, "bounds" | "capped">): RoutingTable {
  return { bounds: manifest.bounds, capped: new Set(manifest.capped) };
}
