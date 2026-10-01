// Checks against the Python reference (research/ranking/ranking.py), through fixtures
// written by research/ranking/port/dump_core_fixture.py. The full-scale check is
// scripts/parity.ts.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  type Candidate,
  matchFeatures,
  matchScore,
  REFERENCE_MATCH_WEIGHTS,
  topK,
} from "./score.ts";
import { fold, indexTerms, nameTokens, queryTokens } from "./tokens.ts";

interface Reference {
  names: [string, string[], string[]][];
  queries: [string, string[]][];
  pool: [number, string, string, number][];
  top: [string, number[]][];
  scores: [string, string, number | null][];
}

const reference = JSON.parse(
  readFileSync(new URL("../fixtures/reference.json", import.meta.url), "utf8"),
) as Reference;

describe("tokens", () => {
  test("nameTokens matches the reference", () => {
    const differences = reference.names.filter(
      ([name, seq, extras]) => JSON.stringify(nameTokens(name)) !== JSON.stringify({ seq, extras }),
    );
    expect(differences).toEqual([]);
  });

  test("queryTokens matches the reference", () => {
    const differences = reference.queries.filter(
      ([query, tokens]) => JSON.stringify(queryTokens(query)) !== JSON.stringify(tokens),
    );
    expect(differences).toEqual([]);
  });

  test("fold handles letters NFKD leaves alone", () => {
    expect(fold("Mærsk Ørsted Straße Łódź Þór")).toBe("maersk orsted strasse lodz thor");
  });

  test("indexTerms skips single characters", () => {
    expect([...indexTerms(nameTokens("A.P. Møller - Mærsk A/S"))]).toEqual([
      "ap",
      "moller",
      "maersk",
      "as",
    ]);
  });
});

describe("topK", () => {
  const pool: Candidate<number>[] = reference.pool.map(([id, , name, prominence]) => ({
    id,
    prominence,
    names: [nameTokens(name)],
  }));

  test("matches the reference top 10 for every 8th evaluation query", () => {
    const differences = reference.top.filter(
      ([query, top]) =>
        JSON.stringify(
          topK(queryTokens(query), pool, 10, REFERENCE_MATCH_WEIGHTS).map((c) => c.id),
        ) !== JSON.stringify(top),
    );
    expect(differences).toEqual([]);
  });
});

describe("matchScore", () => {
  test("matches the reference bit for bit", () => {
    const differences = reference.scores.filter(([query, name, expected]) => {
      const q = queryTokens(query);
      const actual =
        q.length === 0
          ? null
          : matchScore(matchFeatures(q, nameTokens(name)), REFERENCE_MATCH_WEIGHTS);
      return !Object.is(actual, expected);
    });
    expect(differences).toEqual([]);
  });
});
