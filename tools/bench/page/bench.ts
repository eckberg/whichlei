// Browser side of the timing harness (scripts/browser.ts drives it). Replays queries one
// keystroke at a time, the way the search page will run them on the main thread, and
// times the synchronous work of each keystroke: tokenise, route, parse newly fetched
// files, merge candidates, score. Fetching is not timed; files are fetched before a
// query's replay starts.
import {
  filePath,
  type Manifest,
  queryTokens,
  type RoutingTable,
  route,
  routingTable,
  topK,
} from "@whichlei/core";
import { encoding, type Scored } from "../src/encodings.ts";

export interface QueryTiming {
  query: string;
  /** Milliseconds per keystroke that has tokens. */
  keystrokes: number[];
  /** Parse share of each keystroke. */
  parse: number[];
  files: number;
  /** The final top 10, LEIs. */
  top: string[];
}

interface Loaded {
  name: string;
  manifest: Manifest;
  table: RoutingTable;
}

let loaded: Loaded | undefined;

async function fetchText(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.arrayBuffer();
}

/** Load an encoding's manifest. Returns the parse time of the manifest in ms. */
async function load(name: string): Promise<number> {
  const bytes = await fetchText(`/data/${name}/index.json`);
  const t0 = performance.now();
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
  const table = routingTable(manifest);
  const t1 = performance.now();
  loaded = { name, manifest, table };
  return t1 - t0;
}

function current(): Loaded {
  if (!loaded) throw new Error("call load() first");
  return loaded;
}

const url = (l: Loaded, file: number) => `/data/${l.name}/${filePath(l.manifest, file)}`;

async function runQuery(query: string): Promise<QueryTiming> {
  const l = current();
  const enc = encoding(l.name);
  // Untimed: fetch every file the replay will route to.
  const bytes = new Map<number, ArrayBuffer>();
  for (let k = 1; k <= query.length; k++) {
    const typed = query.slice(0, k);
    for (const f of route(queryTokens(typed), l.table, { lastIsPrefix: !typed.endsWith(" ") })) {
      if (!bytes.has(f)) bytes.set(f, await fetchText(url(l, f)));
    }
  }
  const parsed = new Map<number, Scored[]>();
  const timing: QueryTiming = { query, keystrokes: [], parse: [], files: bytes.size, top: [] };
  for (let k = 1; k <= query.length; k++) {
    const typed = query.slice(0, k);
    const t0 = performance.now();
    const tokens = queryTokens(typed);
    if (tokens.length === 0) continue;
    const files = route(tokens, l.table, { lastIsPrefix: !typed.endsWith(" ") });
    for (const f of files) {
      if (!parsed.has(f)) parsed.set(f, enc.decode(new TextDecoder().decode(bytes.get(f))));
    }
    const t1 = performance.now();
    const seen = new Set<string>();
    const candidates: Scored[] = [];
    for (const f of files) {
      for (const c of parsed.get(f) ?? []) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          candidates.push(c);
        }
      }
    }
    const top = topK(tokens, candidates);
    const t2 = performance.now();
    timing.keystrokes.push(t2 - t0);
    timing.parse.push(t1 - t0);
    timing.top = top.map((c) => c.id);
  }
  return timing;
}

async function runQueries(queries: string[]): Promise<QueryTiming[]> {
  const out: QueryTiming[] = [];
  for (const q of queries) out.push(await runQuery(q));
  return out;
}

/** Parse time in ms of each file: decode, split, tokenise. */
async function parseFiles(files: number[]): Promise<number[]> {
  const l = current();
  const enc = encoding(l.name);
  const out: number[] = [];
  for (const f of files) {
    const buffer = await fetchText(url(l, f));
    const t0 = performance.now();
    enc.decode(new TextDecoder().decode(buffer));
    out.push(performance.now() - t0);
  }
  return out;
}

declare global {
  interface Window {
    bench: {
      load: typeof load;
      runQueries: typeof runQueries;
      parseFiles: typeof parseFiles;
    };
  }
}
window.bench = { load, runQueries, parseFiles };
