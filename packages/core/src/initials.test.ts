// Slice 10: acronyms and names that differ from the query only by their legal form.
import { describe, expect, test } from "vitest";
import {
  MATCH_WEIGHTS,
  matchFeatures,
  matchScore,
  QUERY_STOP,
  REFERENCE_MATCH_WEIGHTS,
  scoreCandidate,
  topK,
} from "./score.ts";
import { formStart, nameInitials, nameTokens, queryTokens } from "./tokens.ts";

const seq = (name: string) => nameTokens(name).seq;
const initials = (name: string) => nameInitials(seq(name), QUERY_STOP);

describe("formStart", () => {
  test.each([
    ["Skandinaviska Enskilda Banken AB (publ)", 3],
    ["BP P.L.C.", 1],
    ["SAS AB", 1],
    ["AB", 1],
    ["Bayerische Motoren Werke Aktiengesellschaft", 3],
    ["KGHM Polska Miedź Spółka Akcyjna", 3],
    ["Acme GmbH & Co. KG", 1],
    ["Royal Bank of Canada", 4],
  ] as const)("%s: the legal form starts at word %i", (name, start) => {
    expect(formStart(seq(name))).toBe(start);
  });
});

describe("nameInitials", () => {
  test.each([
    ["Skandinaviska Enskilda Banken AB", ["seb"]],
    ["INTERNATIONAL BUSINESS MACHINES CORPORATION", ["ibm", "ibmc"]],
    ["BRITISH BROADCASTING CORPORATION", ["bbc"]],
    ["The Hongkong and Shanghai Banking Corporation Limited", ["hsb", "hsbc"]],
    ["Royal Bank of Canada", ["rbc"]],
    // Two words make no initials, but a spelled-out legal form counts as a third.
    ["General Electric Company", ["gec"]],
    ["Bayerische Motoren Werke Aktiengesellschaft", ["bmw", "bmwa"]],
    // An abbreviated legal form is no part of the initials: not "kpn" for Philips.
    ["Koninklijke Philips Electronics N.V.", ["kpe"]],
  ] as const)("%s -> %j", (name, expected) => {
    expect(initials(name)).toEqual(expected);
  });

  test("none for fewer than three words, more than six, or a word that starts with a digit", () => {
    expect(initials("Deutsche Bank AG")).toEqual([]);
    expect(initials("Ericsson AB")).toEqual([]);
    expect(initials("One Two Three Four Five Six Seven")).toEqual([]);
    expect(initials("Acme 2 Holdings")).toEqual([]);
  });
});

describe("matchFeatures", () => {
  test("initials: one query word equal to the name's initials", () => {
    const seb = nameTokens("Skandinaviska Enskilda Banken AB");
    expect(matchFeatures(["seb"], seb).initials).toBe(true);
    expect(matchFeatures(["se"], seb).initials).toBe(false);
    expect(matchFeatures(["seb", "ab"], seb).initials).toBe(false);
    expect(matchFeatures(["seb"], seb).shown).toBe(false);
  });

  test("baseExact: the query is the name less its legal form", () => {
    expect(matchFeatures(["bp"], nameTokens("BP P.L.C.")).baseExact).toBe(true);
    expect(matchFeatures(["bp"], nameTokens("BPCE")).baseExact).toBe(false);
    // A name without a legal form is matched by `exact`, not by this.
    expect(matchFeatures(["axa"], nameTokens("AXA")).baseExact).toBe(false);
    expect(matchFeatures(["bp"], nameTokens("BP Europa SE")).baseExact).toBe(false);
  });
});

describe("matchScore", () => {
  const seb = nameTokens("Skandinaviska Enskilda Banken AB");
  const w = { ...REFERENCE_MATCH_WEIGHTS, m_initials: 6, m_base_exact: 1 };

  test("with the slice 10 weights at 0 initials do not match", () => {
    expect(matchScore(matchFeatures(["seb"], seb), REFERENCE_MATCH_WEIGHTS)).toBeNull();
  });

  test("a name equal to the query but for its legal form gains m_base_exact", () => {
    const bp = matchFeatures(["bp"], nameTokens("BP P.L.C."));
    const reference = matchScore(bp, REFERENCE_MATCH_WEIGHTS) as number;
    expect(matchScore(bp, w)).toBe(reference + 1);
  });

  test("an initials match scores m_initials, unless the words score more", () => {
    expect(matchScore(matchFeatures(["seb"], seb), w)).toBe(6);
    const sebSa = nameTokens("SEB S.A.");
    const words = matchScore(matchFeatures(["seb"], sebSa), REFERENCE_MATCH_WEIGHTS) as number;
    expect(matchScore(matchFeatures(["seb"], sebSa), w)).toBe(words + 1);
  });

  test("the search weights turn the features on", () => {
    expect(MATCH_WEIGHTS.m_initials).toBeGreaterThan(0);
    expect(MATCH_WEIGHTS.m_base_exact).toBeGreaterThan(0);
  });
});

describe("topK", () => {
  const candidate = (id: string, prominence: number, name: string) => ({
    id,
    prominence,
    names: [nameTokens(name)],
  });

  test("finds an acronym's entity, and the bank over a prefix match", () => {
    const pool = [
      candidate("bank", 4.9, "Skandinaviska Enskilda Banken AB"),
      candidate("sebastian", 1, "Sebastian Holding AB"),
      candidate("bp", 5.9, "BP P.L.C."),
      candidate("bpce", 8.6, "BPCE"),
    ];
    expect(topK(queryTokens("SEB"), pool, 1).map((c) => c.id)).toEqual(["bank"]);
    expect(topK(queryTokens("bp"), pool, 1).map((c) => c.id)).toEqual(["bp"]);
    expect(topK(queryTokens("bp"), pool, 1, REFERENCE_MATCH_WEIGHTS).map((c) => c.id)).toEqual([
      "bpce",
    ]);
    expect(
      scoreCandidate(queryTokens("SEB"), pool[0] as (typeof pool)[0], REFERENCE_MATCH_WEIGHTS),
    ).toBeNull();
  });
});
