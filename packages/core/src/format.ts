// The static index: a manifest with the routing table, and one text file per index file.
// The contract between the indexer (slice 5), publishing (slice 6) and search (slice 7).
// docs/index-format.md describes it; docs/specs/04-index-format.md says why.
import type { RoutingTable } from "./route.ts";
import type { Candidate } from "./score.ts";
import { nameTokens } from "./tokens.ts";

/** Bumped on any change a reader of the previous version cannot parse. */
export const FORMAT_VERSION = 1;

/** An index file or manifest that breaks the format. */
export class IndexFormatError extends Error {
  override name = "IndexFormatError";
}

/**
 * A manifest of another format version. The page is older or newer than the index: reload
 * it once to get matching code, then show an error.
 */
export class UnsupportedFormatError extends IndexFormatError {
  override name = "UnsupportedFormatError";
  constructor(readonly format: unknown) {
    super(`unsupported index format ${JSON.stringify(format)}; this code reads ${FORMAT_VERSION}`);
  }
}

/**
 * Registration status, lower case when the entity status is INACTIVE: I issued, L lapsed,
 * T pending transfer, P pending archival, R retired, D duplicate, A annulled, M merged.
 */
export type Status = RegistrationStatus | Lowercase<RegistrationStatus>;
type RegistrationStatus = "I" | "L" | "T" | "P" | "R" | "D" | "A" | "M";

const LEI = /^[0-9A-Z]{20}$/;
const COUNTRY = /^[A-Z]{2}$/;
const STATUS = /^[ILTPRDAM]$/i;
const INTEGER = /^-?\d+$/;

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
  /** Prominence. Stored rounded to PROMINENCE_STEP, so a decoded entry holds the rounded value. */
  prominence: number;
}

/** Prominence is stored as an integer count of this step. */
export const PROMINENCE_STEP = 0.1;
const PROMINENCE_SCALE = Math.round(1 / PROMINENCE_STEP);

/** The stored integer: prominence × 10, rounded with Math.round (halves toward +∞). */
function storedProminence(prominence: number): number {
  const stored = Math.round(prominence * PROMINENCE_SCALE);
  if (!Number.isSafeInteger(stored)) throw new IndexFormatError(`bad prominence ${prominence}`);
  return stored === 0 ? 0 : stored; // no -0: a decoded "0" is +0
}

/** Round prominence the way the index stores it: 0.25 -> 0.3, -0.25 -> -0.2, -0.26 -> -0.3. */
export function roundProminence(prominence: number): number {
  return storedProminence(prominence) / PROMINENCE_SCALE;
}

/** Tabs and line breaks separate fields and entries, so names hold a space instead. */
function clean(name: string): string {
  return name.replace(/[\t\n\r]/g, " ");
}

/**
 * One index file: one line per entry, each ending in "\n", fields separated by tabs.
 *   lei, prominence (integer count of PROMINENCE_STEP), country, status, legal name, other names...
 * Throws IndexFormatError on an entry the format cannot hold.
 */
export function encodeEntries(entries: Iterable<Entry>): string {
  let out = "";
  for (const e of entries) {
    const fail = (why: string) => new IndexFormatError(`${e.lei}: ${why}`);
    if (!LEI.test(e.lei)) throw fail("bad LEI");
    if (!COUNTRY.test(e.country)) throw fail(`bad country ${JSON.stringify(e.country)}`);
    if (!STATUS.test(e.status)) throw fail(`bad status ${JSON.stringify(e.status)}`);
    const name = clean(e.name);
    if (name === "") throw fail("empty legal name");
    const otherNames = e.otherNames.map(clean);
    const seen = new Set([name]);
    for (const other of otherNames) {
      if (other === "") throw fail("empty other name");
      if (seen.has(other)) throw fail(`other name repeats a name: ${JSON.stringify(other)}`);
      seen.add(other);
    }
    const prominence = String(storedProminence(e.prominence));
    out += `${[e.lei, prominence, e.country, e.status, name, ...otherNames].join("\t")}\n`;
  }
  return out;
}

/**
 * Parse one index file. Strict: lines end in "\n" (the last one too), none is empty, and a
 * "\r" anywhere is an error. Throws IndexFormatError.
 */
export function decodeEntries(text: string): Entry[] {
  if (text.includes("\r")) throw new IndexFormatError("carriage return in index file");
  if (text !== "" && !text.endsWith("\n")) throw new IndexFormatError("missing final newline");
  const entries: Entry[] = [];
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const [lei, prominence, country, status, name, ...otherNames] = text
      .slice(start, end)
      .split("\t");
    if (
      lei === undefined ||
      !LEI.test(lei) ||
      prominence === undefined ||
      !INTEGER.test(prominence) ||
      country === undefined ||
      !COUNTRY.test(country) ||
      status === undefined ||
      !STATUS.test(status) ||
      !name ||
      otherNames.includes("")
    ) {
      throw new IndexFormatError(`malformed index entry at offset ${start}`);
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
  /** Directory of this build's files: golden-copy date and a content hash, YYYYMMDD-<hex>. */
  build: string;
  /** Publish date of the GLEIF golden copy, YYYY-MM-DD. */
  asOf: string;
  /** Entities reachable through the index. */
  entities: number;
  /** First term of each index file, strictly ascending. */
  bounds: string[];
  /** Files cut to the highest-prominence entries, ascending. */
  capped: number[];
}

const BUILD = /^\d{8}-[0-9a-f]{8,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TERM = /^[a-z0-9]+$/;

/**
 * Check a parsed `index.json` and return it as a Manifest. Throws UnsupportedFormatError
 * for another format version and IndexFormatError for anything else wrong. Unknown fields
 * are dropped.
 */
export function parseManifest(json: unknown): Manifest {
  const fail = (why: string) => new IndexFormatError(`index.json: ${why}`);
  if (typeof json !== "object" || json === null) throw fail("not an object");
  const m = json as Record<string, unknown>;
  if (m.format !== FORMAT_VERSION) throw new UnsupportedFormatError(m.format);
  const { build, asOf, entities, bounds, capped } = m;
  if (typeof asOf !== "string" || !DATE.test(asOf) || !isDate(asOf)) throw fail("bad asOf");
  if (typeof build !== "string" || !BUILD.test(build)) throw fail("bad build");
  if (build.slice(0, 8) !== asOf.replaceAll("-", "")) throw fail("build is not from asOf");
  if (!Number.isSafeInteger(entities) || (entities as number) < 0) throw fail("bad entities");
  if (!Array.isArray(bounds) || bounds.length === 0) throw fail("no bounds");
  bounds.forEach((term: unknown, i) => {
    if (typeof term !== "string" || !TERM.test(term)) throw fail(`bad bound ${i}`);
    if (i > 0 && !(bounds[i - 1] < term)) throw fail(`bounds not ascending at ${i}`);
  });
  if (!Array.isArray(capped)) throw fail("no capped");
  capped.forEach((file: unknown, i) => {
    if (!Number.isSafeInteger(file) || (file as number) < 0 || (file as number) >= bounds.length) {
      throw fail(`bad capped file ${i}`);
    }
    if (i > 0 && !(capped[i - 1] < (file as number))) throw fail(`capped not ascending at ${i}`);
  });
  return {
    format: FORMAT_VERSION,
    build,
    asOf,
    entities: entities as number,
    bounds: bounds as string[],
    capped: capped as number[],
  };
}

function isDate(iso: string): boolean {
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso);
}

/**
 * Path of index file `file`, relative to the manifest. Cache parsed files by this path,
 * not by number, so files of two builds never mix.
 */
export function filePath(manifest: Pick<Manifest, "build">, file: number): string {
  return `${manifest.build}/${file}.txt`;
}

export function routingTable(manifest: Pick<Manifest, "bounds" | "capped">): RoutingTable {
  return { bounds: manifest.bounds, capped: new Set(manifest.capped) };
}
