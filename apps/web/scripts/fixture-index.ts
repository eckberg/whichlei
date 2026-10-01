// A small index for tests and local work: the prototype's 2,924 records and three of its own, encoded with the
// format in packages/core and packed the way the real index is (files of consecutive index
// terms, closed before they hold too many entries), with a small cap so that there are
// dozens of files and routing has something to decide.
//
//   node scripts/fixture-index.ts [dir]      writes dir/index.json and dir/<build>/<n>.txt
//
// Nothing generated is committed: the e2e run and the tests build it, which takes a moment.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import {
  type Entry,
  encodeEntries,
  FORMAT_VERSION,
  filePath,
  indexTerms,
  type Manifest,
  nameTokens,
  type Status,
} from "@whichlei/core";

const prototype = new URL("../../../design/prototype/", import.meta.url);

/** A record of design/prototype/data.js, the fields the index uses. */
interface PrototypeRecord {
  /** LEI. */
  l: string;
  /** Legal name. */
  n: string;
  /** Other names. */
  o?: string[];
  /** Country. */
  c?: string;
  /** Entity status. */
  s?: string;
  /** Registration status. */
  g?: string;
  /** Prominence. */
  p: number;
}

interface PrototypeData {
  asof: string;
  records: PrototypeRecord[];
}

/**
 * Records the prototype lacks, for names that look like identifiers. Each is an LEI's shape once
 * its spaces are gone, or is an LEI (valid or not) as a whole: a search must find them by name.
 */
export const LEI_SHAPED_NAME = "AST Bond Portfolio 2021";
/** A name that is itself a valid LEI (the check digits verify), and one that is not. */
export const LEI_NAMED_VALID = "HWUPKR0MPOU8FGXBT394";
export const LEI_NAMED_INVALID = "HWUPKR0MPOU8FGXBT395";
export const LEI_SHAPED_RECORDS: PrototypeRecord[] = [
  { l: "529900ASTBONDPORT001", n: LEI_SHAPED_NAME, c: "SE", p: 1 },
  { l: "529900LEINAMEDVALI01", n: LEI_NAMED_VALID, c: "SE", p: 1 },
  { l: "529900LEINAMEDBAD002", n: LEI_NAMED_INVALID, c: "SE", p: 1 },
];

export function loadPrototype(): PrototypeData {
  const sandbox: { window: { WL_DATA?: PrototypeData } } = { window: {} };
  runInNewContext(readFileSync(new URL("data.js", prototype), "utf8"), sandbox);
  if (!sandbox.window.WL_DATA) throw new Error("data.js did not define WL_DATA");
  const data = sandbox.window.WL_DATA;
  return { ...data, records: [...data.records, ...LEI_SHAPED_RECORDS] };
}

const REGISTRATION: Record<string, string> = {
  ISSUED: "I",
  LAPSED: "L",
  PENDING_TRANSFER: "T",
  PENDING_ARCHIVAL: "P",
  RETIRED: "R",
  DUPLICATE: "D",
  ANNULLED: "A",
  MERGED: "M",
};

function toEntry(r: PrototypeRecord): Entry {
  const registration = REGISTRATION[r.g ?? "ISSUED"] ?? "I";
  return {
    lei: r.l,
    name: r.n,
    otherNames: [...new Set(r.o ?? [])].filter((name) => name !== r.n && name !== ""),
    country: r.c ?? "",
    status: (r.s && r.s !== "ACTIVE" ? registration.toLowerCase() : registration) as Status,
    prominence: r.p,
  };
}

export interface FixtureOptions {
  /** A file closes before it would hold more entries than this. The real index uses 1,500. */
  maxEntries?: number;
}

export interface Fixture {
  manifest: Manifest;
  /** File number to file text. */
  files: Map<number, string>;
  entries: Entry[];
}

/** Pack `data` into index files, as slice 5's indexer will pack the real ones. */
export function buildFixture(data: PrototypeData, { maxEntries = 120 }: FixtureOptions = {}) {
  const entries = data.records.map(toEntry);
  // term -> entries that hold it
  const byTerm = new Map<string, number[]>();
  entries.forEach((entry, i) => {
    const terms = new Set<string>();
    for (const name of [entry.name, ...entry.otherNames]) {
      for (const term of indexTerms(nameTokens(name))) terms.add(term);
    }
    for (const term of terms) {
      const list = byTerm.get(term);
      if (list) list.push(i);
      else byTerm.set(term, [i]);
    }
  });
  const terms = [...byTerm.keys()].sort();

  const bounds: string[] = [];
  const capped: number[] = [];
  const members: number[][] = [];
  let current = new Set<number>();
  const close = () => {
    if (current.size > 0) members.push([...current]);
    current = new Set();
  };
  for (const term of terms) {
    const list = byTerm.get(term) as number[];
    if (list.length > maxEntries) {
      // One word too common for a file: its own file, cut to the most prominent entries.
      close();
      bounds.push(term);
      capped.push(members.length);
      members.push(orderOf(list, entries).slice(0, maxEntries));
      continue;
    }
    const union = new Set([...current, ...list]);
    if (union.size > maxEntries) close();
    if (current.size === 0) bounds.push(term);
    for (const i of list) current.add(i);
  }
  close();

  const files = new Map<number, string>();
  members.forEach((list, n) => {
    files.set(n, encodeEntries(orderOf(list, entries).map((i) => entries[i] as Entry)));
  });
  // A build id as the format names it: the date and a hash of the files.
  const hash = createHash("sha256");
  for (const text of files.values()) hash.update(text);
  const build = `${data.asof.replaceAll("-", "")}-${hash.digest("hex").slice(0, 8)}`;
  const manifest: Manifest = {
    format: FORMAT_VERSION,
    build,
    asOf: data.asof,
    entities: entries.length,
    bounds,
    capped,
  };
  return { manifest, files, entries } satisfies Fixture;
}

/** Prominence first, then LEI, as the format orders a file. */
function orderOf(list: number[], entries: Entry[]): number[] {
  return [...list].sort((a, b) => {
    const x = entries[a] as Entry;
    const y = entries[b] as Entry;
    return y.prominence - x.prominence || (x.lei < y.lei ? -1 : x.lei > y.lei ? 1 : 0);
  });
}

/** Write a fixture under `dir`, replacing what is there. */
export function writeFixture(dir: URL, fixture: Fixture) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(new URL(`${fixture.manifest.build}/`, dir), { recursive: true });
  writeFileSync(new URL("index.json", dir), JSON.stringify(fixture.manifest));
  for (const [n, text] of fixture.files) {
    writeFileSync(new URL(filePath(fixture.manifest, n), dir), text);
  }
}

/** Where the e2e run keeps it. Ignored by the repository. */
export const FIXTURE_DIR = new URL("../.fixture/index/", import.meta.url);

if (import.meta.main) {
  const dir = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : FIXTURE_DIR;
  const fixture = buildFixture(loadPrototype());
  writeFixture(dir, fixture);
  console.log(
    `${fixture.manifest.entities} entities in ${fixture.files.size} files, ${fixture.manifest.capped.length} capped: ${dir.pathname}`,
  );
}
