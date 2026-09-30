// Packing: which entities go into which index file. Port of `Index.__init__` (shard plan
// and file packing) and `Index.cap` in research/ranking/engine.py, with its recommended
// settings, and of the ordering in port/dump_index.py.
//
//  1. A shard is a range of index terms: all terms with the same first two characters, split
//     one character deeper while it holds more than SPLIT postings (at most MAX_DEPTH deep;
//     a term equal to the prefix stays at its node).
//  2. Shards are packed in term order into files. A file closes before the shard that would
//     take it past FILE_POSTINGS postings, so only a single oversized shard ("limited")
//     makes a file with more entities than that.
//  3. A file with more than CAP entities keeps the CAP most prominent. Entities sit in a
//     file by prominence, highest first, then by number (the order of the golden copy).
import type { Postings } from "./postings.ts";

/** A prefix with more postings than this splits one character deeper. */
export const SPLIT = 1500;
export const MAX_DEPTH = 14;
/** A file closes before it takes more postings than this. */
export const FILE_POSTINGS = 1500;
/** A file keeps at most this many entities. */
export const CAP = 1500;

/** The words [start, end) of the sorted word list. */
export type Range = readonly [start: number, end: number];

/** The shards of the sorted words: ranges that are never split across files. */
export function planShards(
  words: readonly string[],
  postings: ArrayLike<number>,
  split = SPLIT,
): Range[] {
  const shards: Range[] = [];
  const count = (a: number, b: number) => (postings[b] as number) - (postings[a] as number);

  function plan(prefix: string, a: number, b: number): void {
    if (count(a, b) <= split || prefix.length >= MAX_DEPTH) {
      shards.push([a, b]);
      return;
    }
    const depth = prefix.length;
    let i = a;
    // The word equal to the prefix stays here.
    if ((words[i] as string).length <= depth) {
      shards.push([i, i + 1]);
      i++;
    }
    while (i < b) {
      const char = (words[i] as string)[depth];
      let j = i;
      while (j < b && (words[j] as string)[depth] === char) j++;
      plan(prefix + char, i, j);
      i = j;
    }
  }

  let i = 0;
  while (i < words.length) {
    const prefix = (words[i] as string).slice(0, 2);
    let j = i;
    while (j < words.length && (words[j] as string).startsWith(prefix)) j++;
    plan(prefix, i, j);
    i = j;
  }
  return shards;
}

/** Pack shards into files: the word range of each, in order. */
export function packShards(
  shards: readonly Range[],
  postings: ArrayLike<number>,
  wordCount: number,
  limit = FILE_POSTINGS,
): Range[] {
  const files: Range[] = [];
  let start = -1;
  let held = 0;
  for (const [a, b] of shards) {
    const size = (postings[b] as number) - (postings[a] as number);
    if (start >= 0 && held + size > limit) {
      files.push([start, a]);
      start = -1;
      held = 0;
    }
    if (start < 0) start = a;
    held += size;
  }
  if (start >= 0) files.push([start, wordCount]);
  return files;
}

export interface Packing {
  /** First term of each file. */
  bounds: string[];
  /** Files that held more than CAP entities and were cut, ascending. */
  capped: number[];
  /** Entities of each file in file order: prominence descending, then number. */
  files: Int32Array[];
  /** Entities that are in at least one file. */
  reachable: number;
  /** 1 for each entity that is in at least one file. */
  inIndex: Uint8Array;
}

export interface PackOptions {
  split?: number;
  limit?: number;
  cap?: number;
  /** Order of the entities among equal prominence, lowest first. Default: their number. */
  rank?: ArrayLike<number>;
}

/**
 * Pack the postings into index files. `prominence[e]` is the prominence of entity `e`
 * at full precision; entity numbers break ties. The options are for tests; the defaults
 * are the research's.
 */
export function pack(
  postings: Postings,
  prominence: ArrayLike<number>,
  { split = SPLIT, limit = FILE_POSTINGS, cap = CAP, rank }: PackOptions = {},
): Packing {
  const { words, start, entities } = postings;
  const shards = planShards(words, start, split);
  const ranges = packShards(shards, start, words.length, limit);

  const bounds: string[] = [];
  const capped: number[] = [];
  const files: Int32Array[] = [];
  const seen = new Uint8Array(prominence.length);
  let reachable = 0;
  const order =
    rank === undefined
      ? (a: number, b: number) => (prominence[b] as number) - (prominence[a] as number) || a - b
      : (a: number, b: number) =>
          (prominence[b] as number) - (prominence[a] as number) ||
          (rank[a] as number) - (rank[b] as number);

  ranges.forEach(([a, b], n) => {
    bounds.push(words[a] as string);
    // The entities of the file: each once, in number order.
    const all = entities.slice(start[a], start[b]).sort();
    let unique = 0;
    for (let i = 0; i < all.length; i++) {
      if (i === 0 || all[i] !== all[i - 1]) all[unique++] = all[i] as number;
    }
    const held = all.subarray(0, unique).sort(order);
    if (held.length > cap) capped.push(n);
    const kept = held.slice(0, cap);
    for (const e of kept) {
      if (seen[e] === 0) {
        seen[e] = 1;
        reachable++;
      }
    }
    files.push(kept);
  });
  return { bounds, capped, files, reachable, inIndex: seen };
}
