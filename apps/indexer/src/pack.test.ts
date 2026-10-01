import { describe, expect, test } from "vitest";
import { pack, packShards, planShards } from "./pack.ts";
import { PostingsBuilder } from "./postings.ts";

/** Postings from `entity: terms`, with entity numbers in the order given. */
function postingsOf(terms: string[][]) {
  const builder = new PostingsBuilder();
  terms.forEach((t, entity) => {
    builder.add(entity, new Set(t));
  });
  return builder.finish();
}

describe("postings", () => {
  test("groups entities by term, terms in code unit order, entities ascending", () => {
    const { words, start, entities } = postingsOf([["b", "a"], ["b"], ["a", "c", "b"]]);
    expect(words).toEqual(["a", "b", "c"]);
    expect([...start]).toEqual([0, 2, 5, 6]);
    expect([...entities]).toEqual([0, 2, 0, 1, 2, 2]);
  });

  test("an empty builder gives empty postings", () => {
    const { words, start, entities } = postingsOf([]);
    expect(words).toEqual([]);
    expect([...start]).toEqual([0]);
    expect(entities).toHaveLength(0);
  });
});

describe("shards", () => {
  // Words with their posting counts: a prefix of two characters is one shard until it holds
  // more than `split` postings, then it splits one character deeper.
  const words = ["ab", "abc", "abd", "abe", "ac", "bz"];
  const counts = [1, 1, 2, 3, 1, 4];
  const start = new Int32Array(counts.length + 1);
  counts.forEach((c, i) => {
    start[i + 1] = (start[i] as number) + c;
  });

  test("a prefix within the limit is one shard", () => {
    // "ab" and "ac" are different two-character prefixes, so different shards.
    expect(planShards(words, start, 100)).toEqual([
      [0, 4],
      [4, 5],
      [5, 6],
    ]);
  });

  test("a prefix over the limit splits one character deeper; the prefix word stays at its node", () => {
    // "ab" holds 7 postings: the word "ab" alone, then abc, abd, abe by their third
    // character; "ac" is a shard of its own.
    expect(planShards(words, start, 5)).toEqual([
      [0, 1], // ab
      [1, 2], // abc
      [2, 3], // abd
      [3, 4], // abe
      [4, 5], // ac
      [5, 6], // bz
    ]);
    // Exactly at the limit does not split.
    expect(planShards(words, start, 7)).toEqual([
      [0, 4],
      [4, 5],
      [5, 6],
    ]);
  });

  test("a file closes before the shard that would take it past the limit", () => {
    const shards: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ];
    // Shard sizes 1, 1, 2, 3, 1, 4.
    expect(packShards(shards, start, 6, 4)).toEqual([
      [0, 3], // 1 + 1 + 2 = 4
      [3, 5], // 3 + 1 = 4
      [5, 6], // 4
    ]);
    // A shard over the limit gets a file of its own, however big.
    expect(packShards(shards, start, 6, 2)).toEqual([
      [0, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ]);
  });
});

describe("pack", () => {
  // Ten entities share "common"; "rare" and "other" have a few each.
  const terms = [
    ["common", "rare"],
    ["common"],
    ["common", "other"],
    ["common"],
    ["common", "rare"],
    ["common"],
    ["common", "other"],
    ["common"],
    ["common"],
    ["common", "rare", "other"],
  ];
  // Entity 4 is the most prominent, then 9 and 2; the rest tie and go by number.
  const prominence = [0, 0, 1, 0, 3, 0, 0, 0, 0, 2];

  test("a file holds each entity once; files are cut to the cap by prominence, then number", () => {
    const { bounds, capped, files, reachable } = pack(postingsOf(terms), prominence, {
      split: 4,
      limit: 4,
      cap: 4,
    });
    // "common" has 10 postings: its own file, cut to 4. "other" (3) and "rare" (3) close
    // a file together at 4 only if they fit: 3 + 3 > 4, so they do not.
    expect(bounds).toEqual(["common", "other", "rare"]);
    expect(capped).toEqual([0]);
    expect(files.map((f) => [...f])).toEqual([
      [4, 9, 2, 0], // prominence 3, 2, 1, then the first of the ties
      [9, 2, 6],
      [4, 9, 0],
    ]);
    expect(reachable).toBe(5); // 0, 2, 4, 6 and 9: the rest are cut from every file
  });

  test("small terms share a file until it is full", () => {
    const { bounds, capped, files } = pack(postingsOf(terms), prominence, {
      split: 4,
      limit: 6,
      cap: 10,
    });
    expect(bounds).toEqual(["common", "other"]);
    expect(capped).toEqual([]); // exactly the cap is not over it
    expect(files[0]).toHaveLength(10);
    expect([...(files[1] ?? [])]).toEqual([4, 9, 2, 0, 6]); // other + rare
  });

  test("equal prominence goes by rank when one is given, else by entity number", () => {
    const postings = () => postingsOf([["aa"], ["aa"], ["aa"]]);
    expect(pack(postings(), [0, 0, 0]).files.map((f) => [...f])).toEqual([[0, 1, 2]]);
    const rank = [2, 0, 1];
    expect(pack(postings(), [0, 0, 0], { rank }).files.map((f) => [...f])).toEqual([[1, 2, 0]]);
    // Cut to the cap, rank decides who stays.
    const cut = pack(postings(), [0, 0, 0], { rank, cap: 2 });
    expect(cut.files.map((f) => [...f])).toEqual([[1, 2]]);
  });

  test("an entity in two terms of one file appears once", () => {
    const { files } = pack(postingsOf([["aa", "ab"], ["aa"]]), [0, 0]);
    expect(files.map((f) => [...f])).toEqual([[0, 1]]);
  });

  test("the default limits are the research's", () => {
    // 1,501 entities with one word: one shard over the limit, one file, capped at 1,500.
    const many = Array.from({ length: 1501 }, () => ["word"]);
    const { files, capped } = pack(postingsOf(many), new Float32Array(1501));
    expect(capped).toEqual([0]);
    expect(files[0]).toHaveLength(1500);
    expect(files[0]?.[1499]).toBe(1499);
  });
});
