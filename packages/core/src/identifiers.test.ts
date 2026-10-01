import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { identifierReadings, isValidBic, isValidIsin, isValidLei } from "./identifiers.ts";

const EVAL_DIR = new URL("../../../research/ranking/eval/", import.meta.url);

/** Every distinct LEI in the evaluation set and the acronym set: the target and alternative columns. */
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
    expect(leis.length).toBe(1674);
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

// Real codes from GLEIF's ISIN and BIC mapping files, a fixed sample.
const ISINS = `US92204Q1031 CH1510932507 PLING0100027 DE000MR6UEQ7 DE000VH9R0K6 DE000DU8L6J3
  DE000FE56K26 US85855GSB85 US88605HD299 US38380ARM17 CH1307251525 DE000PM26LU8 GB00NJFZZZ01
  DE000JY92FG9 NLBNPSE1YUO5 DE000GG0RM95 ES0A06416689 CH0568236779 US06745PUY59 US89115NAE40`
  .trim()
  .split(/\s+/);
const BICS = `LBTCUS44XXX HBUKGB4169D NWBKGB2127V CLRBGB22525 LWAMCY22XXX LZCBCNBLXXX RAIFCH22B64
  SOLADES1SFH AMMBMYKLXXX MKSNUS33XXX CIUKGB2LMAR SMBCTWTPXXX ENEAITM1XXX CLAOGB2LELL
  CODWESMMXXX SPPYAU22XXX LOYDGB21H44 MIDLGB2147V BOFSGB21438 HLFXGB21M25`
  .trim()
  .split(/\s+/);

describe("isValidIsin", () => {
  test("accepts real ISINs", () => {
    expect(ISINS.filter((isin) => !isValidIsin(isin))).toEqual([]);
  });

  test("rejects every ISIN with one digit changed", () => {
    const accepted = ISINS.flatMap((isin) =>
      [...isin].flatMap((char, i) =>
        /[0-9]/.test(char)
          ? [isin.slice(0, i) + ((Number(char) + 1) % 10) + isin.slice(i + 1)]
          : [],
      ),
    ).filter(isValidIsin);
    expect(accepted).toEqual([]);
  });

  test.each([
    ["empty", ""],
    ["too short", "US0378331005".slice(0, 11)],
    ["lower case", "us0378331005"],
    ["digit in country", "U10378331005"],
  ])("rejects %s: %s", (_, code) => {
    expect(isValidIsin(code)).toBe(false);
  });
});

describe("isValidBic", () => {
  test("accepts real BICs, with and without branch", () => {
    const eight = BICS.map((bic) => bic.slice(0, 8));
    expect([...BICS, ...eight].filter((bic) => !isValidBic(bic))).toEqual([]);
  });

  test("accepts a word of the right shape", () => {
    expect(isValidBic("ERICSSON")).toBe(true);
  });

  test.each([
    ["unknown country", "ERICQQON"],
    ["not ISO 3166", "BANKEU22"],
    ["lower case", "lbtcus44"],
    ["nine characters", "LBTCUS44X"],
    ["digit in country", "LBTC1S44"],
  ])("rejects %s: %s", (_, code) => {
    expect(isValidBic(code)).toBe(false);
  });
});

describe("identifierReadings", () => {
  test("normalises spaces and case", () => {
    expect(identifierReadings(" 529900grz2bqy5zm9n49 ")).toEqual({ lei: "529900GRZ2BQY5ZM9N49" });
    expect(identifierReadings(" us92204q1031 ")).toEqual({ isin: "US92204Q1031" });
    expect(identifierReadings("5299 00GR Z2BQ Y5ZM 9N49")).toEqual({ lei: "529900GRZ2BQY5ZM9N49" });
  });

  test("lists every reading", () => {
    expect(identifierReadings("Ericsson")).toEqual({ bic: "ERICSSON" });
    expect(identifierReadings("Volvo")).toEqual({});
  });

  test("reads a BIC with spaces only between all its groups", () => {
    expect(identifierReadings("TEER SE SS XXX")).toEqual({ bic: "TEERSESSXXX" });
    expect(identifierReadings(" teer se ss ")).toEqual({ bic: "TEERSESS" });
    expect(identifierReadings("TEERSESSXXX")).toEqual({ bic: "TEERSESSXXX" });
  });

  test.each([
    "Sony Corp",
    "Sanofi SA",
    "Barclays PLC",
    "Nokia Oyj",
    "TEERSE SS",
    "TEERSESS XXX",
    "TEER  SE SS",
    "TEER SE SS XX X",
  ])("does not read %s as a BIC: the spaces are not between its groups", (input) => {
    expect(identifierReadings(input).bic).toBeUndefined();
  });

  test("reads an ISIN only without spaces, and an LEI only in groups of four", () => {
    // "Volvo Car 2020" is one of the ~1 in 10 names that pass the check digit once spaces go.
    expect(identifierReadings("US9220 4Q1031").isin).toBeUndefined();
    expect(identifierReadings("US 92204Q1031").isin).toBeUndefined();
    expect(identifierReadings("529900GR Z2BQY5ZM9N49").lei).toBeUndefined();
    expect(identifierReadings("5299 00GR Z2BQY5ZM 9N49").lei).toBeUndefined();
    expect(identifierReadings("5299  00GR Z2BQ Y5ZM 9N49").lei).toBeUndefined();
  });

  test("never reads a name with spaces as an ISIN", () => {
    // Twelve letters and digits with a valid check digit once the spaces are gone.
    const names = ["Volvo Car 2020", "Fond 1999 2000", "Volvo Car 1998", "Fond 2019 2020"];
    for (const name of names) expect(identifierReadings(name).isin).toBeUndefined();
  });

  test("upper-cases only ASCII letters", () => {
    expect(identifierReadings("ericßon")).toEqual({});
  });
});
