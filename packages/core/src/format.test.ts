import { describe, expect, test } from "vitest";
import {
  decodeEntries,
  type Entry,
  encodeEntries,
  filePath,
  type Manifest,
  routingTable,
  toCandidate,
} from "./format.ts";
import { route } from "./route.ts";
import { topK } from "./score.ts";
import { queryTokens } from "./tokens.ts";

const ericsson: Entry = {
  lei: "549300W9JLPW15XI9W41",
  name: "Telefonaktiebolaget LM Ericsson",
  otherNames: ["Ericsson", "LM Ericsson"],
  country: "SE",
  status: "I",
  prominence: 2.3456,
};
const retired: Entry = {
  lei: "5299000J2N45DDNE4Y28",
  name: "Mærsk\tOld\nName",
  otherNames: [],
  country: "DK",
  status: "r",
  prominence: -3.06,
};

describe("index file", () => {
  test("encodes one tab-separated line per entry", () => {
    expect(encodeEntries([ericsson, retired])).toBe(
      "549300W9JLPW15XI9W41\t23\tSE\tI\tTelefonaktiebolaget LM Ericsson\tEricsson\tLM Ericsson\n" +
        "5299000J2N45DDNE4Y28\t-31\tDK\tr\tMærsk Old Name\n",
    );
  });

  test("decodes what it encodes, with prominence rounded and separators in names replaced", () => {
    expect(decodeEntries(encodeEntries([ericsson, retired]))).toEqual([
      { ...ericsson, prominence: 2.3 },
      { ...retired, name: "Mærsk Old Name", prominence: -3.1 },
    ]);
  });

  test("decodes an empty file", () => {
    expect(decodeEntries("")).toEqual([]);
  });

  test("rejects a malformed line", () => {
    expect(() => decodeEntries("549300W9JLPW15XI9W41\t23\tSE\n")).toThrow(/malformed/);
    expect(() => decodeEntries("549300W9JLPW15XI9W41\t23\tSE\tX\tName\n")).toThrow(/malformed/);
  });

  test("candidates score on every name", () => {
    const candidates = decodeEntries(encodeEntries([ericsson, retired])).map(toCandidate);
    const [first] = topK(queryTokens("lm erics"), candidates);
    expect(first?.id).toBe(ericsson.lei);
    expect(first?.entry.country).toBe("SE");
  });
});

describe("manifest", () => {
  const manifest: Manifest = {
    format: 1,
    build: "20260916-0a1b2c3d",
    asOf: "2026-09-16",
    entities: 2,
    bounds: ["00", "er", "ericsson", "es"],
    capped: [2],
  };

  test("names files under the build", () => {
    expect(filePath(manifest, 12)).toBe("20260916-0a1b2c3d/12.txt");
  });

  test("gives the routing table", () => {
    const table = routingTable(manifest);
    expect(table.capped.has(2)).toBe(true);
    expect(route(["ericsson"], table)).toEqual([2]);
  });
});
