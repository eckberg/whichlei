import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { isValidLei } from "./lei.ts";

const EVAL_DIR = new URL("../../../research/ranking/eval/", import.meta.url);

/** Every distinct LEI in the evaluation set: the target and alternative columns. */
function evaluationLeis(): string[] {
  const leis = new Set<string>();
  for (const file of readdirSync(EVAL_DIR).filter((name) => name.endsWith(".tsv"))) {
    const [header = "", ...rows] = readFileSync(new URL(file, EVAL_DIR), "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const columns = header.split("\t");
    const target = columns.indexOf("target_lei");
    const alternatives = columns.indexOf("alt_leis");
    for (const row of rows) {
      const cells = row.split("\t");
      for (const lei of [cells[target], ...(cells[alternatives] ?? "").split("|")]) {
        if (lei) leis.add(lei);
      }
    }
  }
  return [...leis].sort();
}

/**
 * Replace the character at `index` with the next one of the same kind. Digit for digit
 * and letter for letter keeps the length of the numeric form, so mod 97 must catch it.
 */
function changeOne(lei: string, index: number): string {
  const char = lei.charAt(index);
  const next = /[0-9]/.test(char)
    ? String((Number(char) + 1) % 10)
    : String.fromCharCode(((char.charCodeAt(0) - 65 + 1) % 26) + 65);
  return lei.slice(0, index) + next + lei.slice(index + 1);
}

const leis = evaluationLeis();

describe("isValidLei", () => {
  test("reads the evaluation set", () => {
    expect(leis.length).toBe(1612);
  });

  test("accepts every LEI in the evaluation set", () => {
    expect(leis.filter((lei) => !isValidLei(lei))).toEqual([]);
  });

  test("rejects every LEI with one character changed", () => {
    const accepted = leis.flatMap((lei) =>
      Array.from({ length: 20 }, (_, index) => changeOne(lei, index)).filter(isValidLei),
    );
    expect(accepted).toEqual([]);
  });

  // Each passes the mod 97 sum, so only the shape check can reject it.
  const passesSum: [string, string][] = [
    ["too long", "529900GRZ2BQY5ZM9N4995"],
    ["lower case", "529900grz2bqy5zm9n49"],
    ["letter in check digits", "529900GRZ2BQY5ZM9NJ0"],
    ["letter in check digits", "529900GRZ2BQY5ZM9NS7"],
  ];

  test.each(passesSum)("%s passes the mod 97 sum: %s", (_, code) => {
    const digits = [...code.toUpperCase()].map((char) => Number.parseInt(char, 36)).join("");
    expect(BigInt(digits) % 97n).toBe(1n);
  });

  test.each([["empty", ""], ...passesSum])("rejects %s: %s", (_, code) => {
    expect(isValidLei(code)).toBe(false);
  });

  test.each([
    ["too short", "529900GRZ2BQY5ZM9N4"],
    ["space", "529900GRZ2BQY5ZM9N4 9"],
    ["non-ASCII", "529900GRZ2BQY5ZM9NÅ9"],
  ])("rejects %s: %s", (_, code) => {
    expect(isValidLei(code)).toBe(false);
  });
});
