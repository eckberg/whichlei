import { queryTokens } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import { statusOf } from "./entry.ts";
import { markRanges, nameMarks } from "./highlight.ts";

const marked = (query: string, name: string) =>
  markRanges(queryTokens(query), name).map(([a, b]) => name.slice(a, b));

describe("markRanges", () => {
  it("marks the typed part of a word", () => {
    expect(marked("eric", "Telefonaktiebolaget LM Ericsson")).toEqual(["Eric"]);
    expect(marked("telef eric", "Telefonaktiebolaget LM Ericsson")).toEqual(["Telef", "Eric"]);
  });

  it("marks a whole word the query spells out", () => {
    expect(marked("volvo car", "Volvo Car Corporation")).toEqual(["Volvo", "Car"]);
  });

  it("finds words through folding: accents and letters NFKD leaves alone", () => {
    expect(marked("maersk", "Mærsk A/S")).toEqual(["Mærsk"]);
    expect(marked("zurich", "Zürich Versicherung")).toEqual(["Zürich"]);
    expect(marked("strasse", "Hauptstraße 1 GmbH")).toEqual([]);
    expect(marked("hauptstrasse", "Hauptstraße 1 GmbH")).toEqual(["Hauptstraße"]);
  });

  it("marks words joined by punctuation and single letters", () => {
    expect(marked("h&m", "H & M Hennes & Mauritz AB")).toEqual(["H & M"]);
    expect(marked("cocacola", "Coca-Cola Europacific Partners")).toEqual(["Coca-Cola"]);
    expect(marked("att", "AT&T Inc.")).toEqual(["AT&T"]);
  });

  it("marks a fuzzy match by the typed length", () => {
    expect(marked("ericssen", "Ericsson Holding")).toEqual(["Ericsson"]);
  });

  it("marks nothing for words that do not match", () => {
    expect(marked("zzz", "Ericsson")).toEqual([]);
  });

  it("does not split a character whose fold is longer than one", () => {
    const name = "Œuvre Ærø";
    const ranges = markRanges(queryTokens("oeuvre aero"), name);
    expect(ranges.map(([a, b]) => name.slice(a, b))).toEqual(["Œuvre", "Ærø"]);
  });
});

describe("nameMarks", () => {
  it("marks the legal name when it matches", () => {
    const marks = nameMarks(["eric"], "Ericsson", ["Other"]);
    expect(marks.legal).toHaveLength(1);
    expect(marks.aka).toBeUndefined();
  });

  it("falls back to the other name that matches best", () => {
    const marks = nameMarks(["hm"], "Hennes & Mauritz AB", ["H&M", "Hennes Mauritz Sverige"]);
    expect(marks.legal).toEqual([]);
    expect(marks.aka?.name).toBe("H&M");
  });

  it("has no aka when nothing matches", () => {
    expect(nameMarks(["zzz"], "Ericsson", ["x"]).aka).toBeUndefined();
  });
});

describe("statusOf", () => {
  it("reads the status letter the way the record page does", () => {
    expect(statusOf("I")).toEqual({ label: "active", tone: "active" });
    expect(statusOf("T")).toEqual({ label: "active", tone: "active" });
    expect(statusOf("P")).toEqual({ label: "active", tone: "active" });
    expect(statusOf("L")).toEqual({ label: "lapsed", tone: "lapsed" });
    expect(statusOf("R")).toEqual({ label: "retired", tone: "retired" });
    expect(statusOf("M")).toEqual({ label: "merged", tone: "retired" });
    expect(statusOf("i")).toEqual({ label: "inactive", tone: "retired" });
    expect(statusOf("l")).toEqual({ label: "inactive", tone: "retired" });
  });
});
