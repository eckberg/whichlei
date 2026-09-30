import { describe, expect, test } from "vitest";
import {
  decodeEntries,
  type Entry,
  encodeEntries,
  filePath,
  IndexFormatError,
  type Manifest,
  parseManifest,
  roundProminence,
  routingTable,
  toCandidate,
  UnsupportedFormatError,
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
const line = (...fields: string[]) => `${fields.join("\t")}\n`;

describe("index file", () => {
  test("encodes one tab-separated line per entry", () => {
    expect(encodeEntries([ericsson, retired])).toBe(
      line("549300W9JLPW15XI9W41", "23", "SE", "I", ericsson.name, "Ericsson", "LM Ericsson") +
        line("5299000J2N45DDNE4Y28", "-31", "DK", "r", "Mærsk Old Name"),
    );
  });

  test("decodes what it encodes, with prominence rounded and separators in names replaced", () => {
    expect(decodeEntries(encodeEntries([ericsson, retired]))).toEqual([
      { ...ericsson, prominence: 2.3 },
      { ...retired, name: "Mærsk Old Name", prominence: -3.1 },
    ]);
  });

  test("rounds halves toward +∞, negatives included", () => {
    const cases: [number, string, number][] = [
      [0.25, "3", 0.3],
      [-0.25, "-2", -0.2],
      [-0.26, "-3", -0.3],
      [-0.04, "0", 0],
      [-12.35, "-123", -12.3],
    ];
    for (const [prominence, stored, decoded] of cases) {
      const text = encodeEntries([{ ...ericsson, otherNames: [], prominence }]);
      expect(text.split("\t")[1]).toBe(stored);
      expect(decodeEntries(text)[0]?.prominence).toBe(decoded);
      expect(roundProminence(prominence)).toBe(decoded);
    }
  });

  test("decodes an empty file", () => {
    expect(decodeEntries("")).toEqual([]);
  });

  const good = line("549300W9JLPW15XI9W41", "23", "SE", "I", "Name");
  test.each([
    ["a malformed LEI", line("549300W9JLPW15XI9W4", "23", "SE", "I", "Name")],
    ["a prominence that is not an integer", line("549300W9JLPW15XI9W41", "2.3", "SE", "I", "Name")],
    ["an empty prominence", line("549300W9JLPW15XI9W41", "", "SE", "I", "Name")],
    ["a bad country", line("549300W9JLPW15XI9W41", "23", "se", "I", "Name")],
    ["a bad status", line("549300W9JLPW15XI9W41", "23", "SE", "X", "Name")],
    ["a missing legal name", line("549300W9JLPW15XI9W41", "23", "SE", "I")],
    ["an empty legal name", line("549300W9JLPW15XI9W41", "23", "SE", "I", "")],
    ["an empty other name", line("549300W9JLPW15XI9W41", "23", "SE", "I", "Name", "")],
    ["no final newline", good.slice(0, -1)],
    ["an empty line", `${good}\n${good}`],
    ["a carriage return", good.replace("\n", "\r\n")],
    ["a carriage return in a name", good.replace("Name", "Na\rme")],
  ])("rejects %s", (_, text) => {
    expect(() => decodeEntries(text)).toThrow(IndexFormatError);
  });

  test.each<[string, Partial<Entry>]>([
    ["an invalid LEI", { lei: "549300w9jlpw15xi9w41" }],
    ["a short LEI", { lei: "549300W9JLPW15XI9W4" }],
    ["a bad country", { country: "SWE" }],
    ["a bad status", { status: "X" as Entry["status"] }],
    ["an empty legal name", { name: "" }],
    ["an empty other name", { otherNames: [""] }],
    ["a repeated other name", { otherNames: ["Ericsson", "Ericsson"] }],
    ["an other name equal to the legal name", { otherNames: [ericsson.name] }],
    ["an other name equal to the legal name after cleaning", { name: "A B", otherNames: ["A\tB"] }],
    ["a prominence that is not a number", { prominence: Number.NaN }],
    ["an infinite prominence", { prominence: Number.POSITIVE_INFINITY }],
  ])("will not encode %s", (_, change) => {
    expect(() => encodeEntries([{ ...ericsson, ...change }])).toThrow(IndexFormatError);
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

  test("parses a valid manifest and drops unknown fields", () => {
    expect(parseManifest({ ...manifest, extra: true })).toEqual(manifest);
  });

  test("rejects another format version with its own error", () => {
    expect(() => parseManifest({ ...manifest, format: 2 })).toThrow(UnsupportedFormatError);
    expect(() => parseManifest({ ...manifest, format: "1" })).toThrow(UnsupportedFormatError);
  });

  test.each<[string, unknown]>([
    ["not an object", "index"],
    ["a build without a hash", { ...manifest, build: "20260916" }],
    ["a build with upper-case hex", { ...manifest, build: "20260916-0A1B2C3D" }],
    ["a build from another date", { ...manifest, build: "20260915-0a1b2c3d" }],
    ["an impossible date", { ...manifest, asOf: "2026-02-30", build: "20260230-0a1b2c3d" }],
    ["a date in another form", { ...manifest, asOf: "16.09.2026" }],
    ["negative entities", { ...manifest, entities: -1 }],
    ["fractional entities", { ...manifest, entities: 1.5 }],
    ["no bounds", { ...manifest, bounds: [] }],
    ["a bound outside [a-z0-9]", { ...manifest, bounds: ["00", "Er"] }],
    ["an empty bound", { ...manifest, bounds: ["", "00"] }],
    ["bounds out of order", { ...manifest, bounds: ["er", "00"] }],
    ["a repeated bound", { ...manifest, bounds: ["00", "00"] }],
    ["capped out of range", { ...manifest, capped: [4] }],
    ["capped repeated", { ...manifest, capped: [2, 2] }],
    ["capped out of order", { ...manifest, capped: [2, 1] }],
    ["capped not integers", { ...manifest, capped: [1.5] }],
  ])("rejects %s", (_, json) => {
    expect(() => parseManifest(json)).toThrow(IndexFormatError);
    expect(() => parseManifest(json)).not.toThrow(UnsupportedFormatError);
  });

  test("names files under the build", () => {
    expect(filePath(manifest, 12)).toBe("20260916-0a1b2c3d/12.txt");
  });

  test("gives the routing table", () => {
    const table = routingTable(manifest);
    expect(table.capped.has(2)).toBe(true);
    expect(route(["ericsson"], table)).toEqual([2]);
  });
});
