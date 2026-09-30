import { describe, expect, test } from "vitest";
import { encodeCodes, readElf, readRegistrationAuthorities } from "./codes.ts";
import { ELF_CSV, RA_CSV } from "./fixture.ts";

describe("codes", () => {
  test("legal forms: the local name of the first row that has one, else another form of it", () => {
    expect(readElf(ELF_CSV)).toEqual({
      // The second row for XJHM (English) does not replace the first.
      XJHM: "Aktiebolag",
      // No local name: the transliterated name.
      ABCD: "Obshchestvo",
    });
  });

  test("a code with no name at all is left out", () => {
    expect(readElf(ELF_CSV)).not.toHaveProperty("8888");
  });

  test("registration authorities: the local name of the organisation, else the register", () => {
    expect(readRegistrationAuthorities(RA_CSV)).toEqual({
      RA000421: "United State Register",
      RA000544: "Bolagsverket",
    });
  });

  test("an unexpected header is an error, not an empty list", () => {
    expect(() => readElf("a,b\n1,2\n")).toThrow(/is missing from the header/);
    expect(() => readRegistrationAuthorities("a,b\n1,2\n")).toThrow(/is missing from the header/);
  });

  test("the file is compact with its keys in order", () => {
    expect(encodeCodes({ elf: { B: "b", A: "a" }, ra: { RA2: "y", RA1: "x" } })).toBe(
      '{"elf":{"A":"a","B":"b"},"ra":{"RA1":"x","RA2":"y"}}',
    );
  });
});
