import { describe, expect, it } from "vitest";
import { lookupReadings, readingKey, registerNumber } from "./readings.ts";

const kinds = (input: string) => lookupReadings(input).map((reading) => reading.kind);

describe("lookupReadings", () => {
  it("reads a valid LEI as an LEI only, however it is typed", () => {
    expect(lookupReadings("549300w9jlpw15xifm52")).toEqual([
      { kind: "lei", code: "549300W9JLPW15XIFM52" },
    ]);
    expect(kinds("5493 00W9 JLPW 15XI FM52")).toEqual(["lei"]);
    expect(kinds("549300W9 JLPW15XI FM52")).toEqual([]);
  });

  it("reads a valid ISIN as an ISIN only: it is also twelve characters with ten digits", () => {
    expect(lookupReadings("us0378331005")).toEqual([{ kind: "isin", code: "US0378331005" }]);
  });

  it("reads 8 and 11 characters of BIC shape as a BIC", () => {
    expect(lookupReadings("tomcjp22")).toEqual([{ kind: "bic", code: "TOMCJP22" }]);
    expect(lookupReadings("TEERSESSXXX")).toEqual([{ kind: "bic", code: "TEERSESSXXX" }]);
  });

  it("reads a name that is a valid BIC as a BIC: the lookup decides (decision 8)", () => {
    expect(kinds("ericsson")).toEqual(["bic"]);
  });

  it("reads register numbers as typed, with their spaces and separators", () => {
    expect(lookupReadings("556016-0680")).toEqual([{ kind: "reg.no", code: "556016-0680" }]);
    expect(lookupReadings("  HRB   86891 ")).toEqual([{ kind: "reg.no", code: "HRB 86891" }]);
    expect(kinds("SC123456")).toEqual(["reg.no"]);
    expect(kinds("12.345.678/0001-95")).toEqual(["reg.no"]);
    expect(kinds("12345")).toEqual(["reg.no"]);
  });

  it("can read an input as a BIC and as a register number, the BIC first", () => {
    expect(kinds("1234DE56")).toEqual(["bic", "reg.no"]);
    // No such country in a BIC, so only the register number is left.
    expect(kinds("ZZ123QQ34")).toEqual(["reg.no"]);
  });

  it.each([
    ["a name", "telefonaktiebolaget lm ericsson"],
    ["a name with a year", "AST Bond Portfolio 2021"],
    ["too short", "1234"],
    ["too few digits", "AB1234"],
    ["a fund and a year", "Fund 2021"],
    ["a bond and a year", "Bond 2021"],
    ["an ETF and a year", "ETF 2025"],
    ["a ticker, a number and a year", "AP7 2021"],
    ["only years", "1999 2021"],
    ["names that become BIC shapes", "Sony Corp"],
    ["a name that is an ISIN with its check digit once spaces go", "Volvo Car 2020"],
    ["a name of years that is an ISIN once spaces go", "Fond 1999 2000"],
    ["a name of one BIC-shaped word and a suffix", "Sanofi SA"],
    ["an LEI with its last character missing", "HWUPKR0MPOU8FGXBT39"],
    ["an LEI with a character missing, in groups", "HWUP KR0M POU8 FGXB T39"],
    ["more than any identifier holds", "1234567890123456789012345678901234567"],
    ["punctuation a register number does not have", "5560160680!"],
    ["an LEI with the check digits wrong", "HWUPKR0MPOU8FGXBT395"],
    ["an ISIN with the check digit wrong", "US0378331006"],
    ["nothing", "   "],
  ])("reads %s as nothing", (_, input) => {
    expect(lookupReadings(input)).toEqual([]);
  });

  it("keeps register numbers that look unlike a name", () => {
    // A Chinese unified social credit code: 18 characters.
    expect(kinds("91350100M000100Y43")).toEqual(["reg.no"]);
    expect(kinds("HRB 12345")).toEqual(["reg.no"]);
    expect(kinds("B 1999 12345")).toEqual(["reg.no"]);
    expect(kinds("12345678901234567890123456789012345")).toEqual(["reg.no"]);
    expect(kinds("1234567890123456789012345678901234567")).toEqual([]);
  });

  it("does not read the shape of an ISIN or an LEI as a register number", () => {
    expect(registerNumber("US0378331005")).toBeNull();
    expect(registerNumber("HWUPKR0MPOU8FGXBT395")).toBeNull();
    expect(registerNumber("5560160680")).toBe("5560160680");
  });
});

describe("readingKey", () => {
  it("ignores the case of a register number", () => {
    expect(readingKey({ kind: "reg.no", code: "hrb 1234" })).toBe(
      readingKey({ kind: "reg.no", code: "HRB 1234" }),
    );
    expect(readingKey({ kind: "bic", code: "A" })).not.toBe(
      readingKey({ kind: "isin", code: "A" }),
    );
  });
});
