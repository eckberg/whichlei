// Routing against the Python reference (ranking.route_budget), through a fixture written
// by research/ranking/port/dump_index.py: the reference routing table, and every
// evaluation query typed one character at a time.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type RoutingTable, route } from "./route.ts";
import { queryTokens } from "./tokens.ts";

interface RouteFixture {
  bounds: string[];
  capped: number[];
  /** [query, one "typing|paused" string of comma-separated files per keystroke]. */
  cases: [string, string[]][];
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/route.json", import.meta.url), "utf8"),
) as RouteFixture;
const table: RoutingTable = { bounds: fixture.bounds, capped: new Set(fixture.capped) };

describe("route", () => {
  test("matches the reference for every evaluation query, keystroke by keystroke", () => {
    const differences: string[] = [];
    for (const [query, routes] of fixture.cases) {
      routes.forEach((expected, i) => {
        const typed = query.slice(0, i + 1);
        const tokens = queryTokens(typed);
        const lastIsPrefix = !typed.endsWith(" ");
        const actual = [false, true]
          .map((paused) => route(tokens, table, { lastIsPrefix, paused }).join(","))
          .join("|");
        if (actual !== expected)
          differences.push(`${JSON.stringify(typed)}: ${actual} vs ${expected}`);
      });
    }
    expect(differences).toEqual([]);
    expect(fixture.cases.length).toBe(3229);
  });

  test("routes nothing for an empty query", () => {
    expect(route([], table)).toEqual([]);
  });

  test("routes a short single word only on a pause", () => {
    expect(route(["bp"], table, { paused: false })).toEqual([]);
    expect(route(["bp"], table, { paused: true })).toHaveLength(1);
  });

  test("never routes stopwords and at most two words", () => {
    expect(route(["the", "of"], table)).toEqual([]);
    expect(route(queryTokens("svenska handelsbanken aktiebolag stockholm"), table)).toHaveLength(2);
  });
});
