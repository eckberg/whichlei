import { describe, expect, test } from "vitest";
import {
  codePointLength,
  type ProminenceInput,
  prominence,
  registrationYear,
  W_RECOMMENDED,
  yearFraction,
} from "./prominence.ts";

const NOW = 2026.74;
const base: ProminenceInput = {
  entityStatus: "ACTIVE",
  registrationStatus: "ISSUED",
  category: "GENERAL",
  nDirect: 0,
  nUltimate: 0,
  nBranch: 0,
  hasParent: false,
  isin: 0,
  bic: false,
  registeredYear: Number.NaN,
  nameLength: 1,
};

// Expected values come from engine.prominence (numpy, float32) with ranking.W_RECOMMENDED,
// evaluated for one entity each. The lengths are ones where numpy's float32 log and
// Math.fround(Math.log) agree, so the match is exact, not approximate.
const cases: [string, Partial<ProminenceInput>, number][] = [
  ["nothing known", {}, 0],
  [
    "a large, old group with ISINs and a BIC",
    {
      nDirect: 12,
      nUltimate: 30,
      nBranch: 2,
      isin: 500,
      bic: true,
      registeredYear: 2012 + 10 / 12,
      nameLength: 30,
    },
    4.729755401611328,
  ],
  [
    "a lapsed fund with a parent",
    {
      registrationStatus: "LAPSED",
      category: "FUND",
      hasParent: true,
      isin: 3,
      registeredYear: 2020 + 5 / 12,
      nameLength: 20,
    },
    -1.4208576679229736,
  ],
  [
    "an inactive entity",
    { entityStatus: "INACTIVE", registeredYear: 2000, nameLength: 10 },
    -1.5356109142303467,
  ],
  [
    "a retired government entity (p_gov is 0)",
    {
      registrationStatus: "RETIRED",
      category: "RESIDENT_GOVERNMENT_ENTITY",
      nDirect: 1,
      hasParent: true,
      bic: true,
      registeredYear: 1990,
      nameLength: 50,
    },
    -2.6345696449279785,
  ],
  [
    "a branch; age and ISIN count are capped",
    {
      category: "BRANCH",
      nUltimate: 4,
      nBranch: 7,
      isin: 49,
      bic: true,
      registeredYear: 2026 + 8 / 12,
      nameLength: 40,
    },
    -0.7784020900726318,
  ],
];

describe("prominence", () => {
  test.each(cases)("%s", (_, changes, expected) => {
    expect(prominence({ ...base, ...changes }, NOW)).toBe(expected);
  });

  test("the weights are the fitted ones", () => {
    expect(W_RECOMMENDED.p_dead).toBe(-2.9);
    expect(W_RECOMMENDED.isin_cap).toBe(3.932);
    expect(Object.keys(W_RECOMMENDED)).toHaveLength(13);
  });

  test("an ISIN count past the cap adds nothing more", () => {
    const at = (isin: number) => prominence({ ...base, isin }, NOW);
    expect(at(51)).toBe(at(5000));
    expect(at(49)).toBeLessThan(at(5000));
  });

  test("age counts up to 15 years and no further", () => {
    const at = (year: number) => prominence({ ...base, registeredYear: year }, NOW);
    expect(at(1990)).toBe(at(2000));
    expect(at(2000)).toBeGreaterThan(at(2020));
    // A registration after the golden copy's date counts as age 0, not negative.
    expect(at(2030)).toBe(at(2027));
  });

  test("a parent makes a top parent into a child", () => {
    const top = prominence({ ...base, nDirect: 5 }, NOW);
    const child = prominence({ ...base, nDirect: 5, hasParent: true }, NOW);
    expect(top - child).toBeCloseTo(1.36 + 0.56, 5);
  });

  test("the result is a float32", () => {
    const p = prominence(
      { ...base, nDirect: 3, isin: 7, registeredYear: 2015.5, nameLength: 33 },
      NOW,
    );
    expect(Math.fround(p)).toBe(p);
  });
});

describe("dates", () => {
  test("a registration date is the year plus whole months over 12", () => {
    expect(registrationYear("2012-11-06T09:18:00.000Z")).toBeCloseTo(2012 + 10 / 12, 12);
    expect(registrationYear("2020-01-31")).toBe(2020);
    expect(registrationYear("")).toBeNaN();
    expect(registrationYear("n/a")).toBeNaN();
    expect(registrationYear("20xx-01-01")).toBeNaN();
  });

  test("the golden copy's date is a year fraction by day", () => {
    expect(yearFraction("2026-01-01")).toBe(2026);
    expect(yearFraction("2026-09-16")).toBeCloseTo(2026 + (8 + 15 / 30) / 12, 12);
    expect(yearFraction("2024-03-01")).toBeCloseTo(2024 + 2 / 12, 12);
  });

  test("length counts code points, as Python does", () => {
    expect(codePointLength("Ærø")).toBe(3);
    expect(codePointLength("a😀b")).toBe(3);
    expect(codePointLength("😀😀")).toBe(2);
    expect(codePointLength("")).toBe(0);
  });
});
