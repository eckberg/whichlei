import { describe, expect, test } from "vitest";
import { matchLevel, prefixEditLe1, scoreCandidate } from "./score.ts";
import { nameTokens, queryTokens } from "./tokens.ts";

describe("matchLevel", () => {
  test.each([
    ["volvo", "volvo", 3],
    ["volv", "volvo", 2],
    ["ericson", "ericsson", 1],
    ["erisc", "ericsson", 1],
    ["eric", "erikssen", 1],
    ["ericsson", "volvo", 0],
    ["bq", "bp", 0],
  ] as const)("%s in %s is %i", (query, term, level) => {
    expect(matchLevel(query, term)).toBe(level);
  });
});

describe("prefixEditLe1", () => {
  test.each([
    ["mearsk", "maersk", true],
    ["maersk", "maersk", true],
    ["marsk", "maersk", true],
    ["maaersk", "maersk", true],
    ["mxxrsk", "maersk", false],
    ["abcdef", "abc", false],
  ] as const)("%s against %s is %s", (query, term, expected) => {
    expect(prefixEditLe1(query, term)).toBe(expected);
  });
});

describe("scoreCandidate", () => {
  const ericsson = {
    id: 1,
    prominence: 0,
    names: [nameTokens("Telefonaktiebolaget LM Ericsson"), nameTokens("Ericsson")],
  };

  test("takes the best name", () => {
    const legalOnly = { ...ericsson, names: [ericsson.names[0] ?? nameTokens("")] };
    const both = scoreCandidate(queryTokens("ericsson"), ericsson);
    const legal = scoreCandidate(queryTokens("ericsson"), legalOnly);
    expect(both).not.toBeNull();
    expect(legal).not.toBeNull();
    expect(both ?? 0).toBeGreaterThan(legal ?? 0);
  });

  test("adds prominence", () => {
    const base = scoreCandidate(queryTokens("ericsson"), ericsson) ?? 0;
    expect(scoreCandidate(queryTokens("ericsson"), { ...ericsson, prominence: 1.5 })).toBe(
      base + 1.5,
    );
  });

  test("hides a name that matches only stop words", () => {
    const bank = { id: 2, prominence: 0, names: [nameTokens("Bank of America")] };
    expect(scoreCandidate(queryTokens("republic of latvia"), bank)).toBeNull();
  });
});
