// Which index files a query fetches. Port of ranking.route_budget in
// research/ranking/ranking.py, with its recommended parameters (ROUTE) fixed.
import { QUERY_STOP } from "./score.ts";

/** The routing table: the first term of every index file, sorted, and the capped files. */
export interface RoutingTable {
  /** First term of each file. File i holds the terms from bounds[i] up to bounds[i + 1]. */
  bounds: readonly string[];
  /** Files that hold one oversized word, cut to the entries with the highest prominence. */
  capped: ReadonlySet<number>;
}

export interface RouteOptions {
  /** The last token is still being typed, so it is a prefix. False after a trailing space. */
  lastIsPrefix?: boolean;
  /** The typing has paused (the debounce fired), so an unfinished wide word may route. */
  paused?: boolean;
}

/** A word routes once it has this many characters. */
const MIN_CHARS = 3;
/** A word's anchor prefix spans at most this many files. */
const MAX_SPAN = 1;
/** At most this many words route per query. */
const MAX_ANCHORS = 2;
/** Sorts after every term that starts with the prefix. Terms are [a-z0-9]. */
const PREFIX_END = String.fromCharCode(0xffff);

/** The file that holds `term`: the last file whose first term is <= term. */
function fileOf(bounds: readonly string[], term: string): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bounds[mid] ?? "") <= term) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/** The files one query word routes to, and whether they hold every entity with the word. */
function wordFiles(
  table: RoutingTable,
  word: string,
  inProgress: boolean,
  paused: boolean,
): { files: number[]; full: boolean } {
  if (word.length < MIN_CHARS) return { files: [], full: false };
  // Sticky anchor: the shortest prefix whose range spans few enough files. Prefix ranges
  // nest, so these files stay valid for every longer prefix and for later typos.
  for (let length = MIN_CHARS; length <= word.length; length++) {
    const prefix = word.slice(0, length);
    const first = fileOf(table.bounds, prefix);
    const last = fileOf(table.bounds, prefix + PREFIX_END);
    if (last - first + 1 <= MAX_SPAN) {
      const files = Array.from({ length: last - first + 1 }, (_, i) => first + i);
      return { files, full: !files.some((f) => table.capped.has(f)) };
    }
  }
  // A word that never narrows ("international") routes to the file that holds it, but
  // while it is being typed only on a pause.
  if (inProgress && !paused) return { files: [], full: false };
  const file = fileOf(table.bounds, word);
  return { files: [file], full: !inProgress && !table.capped.has(file) };
}

/**
 * The files to fetch for query tokens, in fetch order. At most two words route, one file
 * each; words whose files hold every entity with the word go first, then longer words.
 */
export function route(
  query: readonly string[],
  table: RoutingTable,
  { lastIsPrefix = true, paused = true }: RouteOptions = {},
): number[] {
  const anchors: { full: boolean; length: number; position: number; files: number[] }[] = [];
  query.forEach((word, position) => {
    if (QUERY_STOP.has(word)) return;
    const inProgress = lastIsPrefix && position === query.length - 1;
    const { files, full } = wordFiles(table, word, inProgress, paused);
    if (files.length > 0) anchors.push({ full, length: word.length, position, files });
  });
  const only = query[0];
  if (anchors.length === 0 && query.length === 1 && only !== undefined && only.length >= 2) {
    // 'bp', '3m': a short single word fetches one file, only on a pause.
    return paused ? [fileOf(table.bounds, only)] : [];
  }
  anchors.sort(
    (a, b) => Number(b.full) - Number(a.full) || b.length - a.length || a.position - b.position,
  );
  const out: number[] = [];
  for (const { files } of anchors.slice(0, MAX_ANCHORS)) {
    for (const file of files) if (!out.includes(file)) out.push(file);
  }
  return out;
}
