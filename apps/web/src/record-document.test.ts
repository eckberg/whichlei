import { describe, expect, it } from "vitest";
import { buildDocument, documentUrl, leisToName, parseDocument } from "./record-document.ts";
import { parsedRecord, recordFixtures } from "./test-helpers.ts";

const ERICSSON = "549300W9JLPW15XIFM52";
const LOU = "549300O897ZC5H7CY412";

describe("leisToName", () => {
  it("is empty for most records: no parent, an exception, or a successor with a name", async () => {
    for (const name of ["record-ericsson", "record-branch", "record-exception", "record-retired"]) {
      expect(leisToName(await parsedRecord(name)), name).toEqual([]);
    }
  });

  it("gives a reported parent, once, though it is both the direct and the ultimate parent", async () => {
    expect(leisToName(await parsedRecord("record-subsidiary"))).toEqual([ERICSSON]);
  });

  it("gives each reported parent and each successor that has an LEI and no name", async () => {
    const record = await parsedRecord("record-subsidiary");
    record.ultimateParent = { kind: "reported", lei: LOU };
    record.successors = [
      { lei: "5493006W3QUS5LMH6R84", name: null },
      { lei: "529900E3CDUZL6H6GX76", name: "Has a name" },
      { lei: null, name: "No LEI" },
      { lei: LOU, name: null },
    ];
    expect(leisToName(record)).toEqual([ERICSSON, LOU, "5493006W3QUS5LMH6R84"]);
  });

  it("leaves out the record's own LEI", async () => {
    const record = await parsedRecord("record-subsidiary");
    record.directParent = { kind: "reported", lei: record.lei };
    record.ultimateParent = { kind: "reported", lei: record.lei };
    record.successors = [{ lei: record.lei, name: null }];
    expect(leisToName(record)).toEqual([]);
  });

  it("leaves out what is not shaped like an LEI, and asks about at most `max`", async () => {
    const record = await parsedRecord("record-subsidiary");
    record.directParent = { kind: "reported", lei: "not an lei" };
    record.ultimateParent = { kind: "reported", lei: LOU };
    record.successors = Array.from({ length: 80 }, (_, i) => ({
      lei: `LEI${String(i).padStart(17, "0")}`,
      name: null,
    }));
    const leis = leisToName(record);
    expect(leis).toHaveLength(50);
    expect(leis[0]).toBe(LOU);
    expect(leisToName(record, 3)).toHaveLength(3);
  });
});

describe("parseDocument", () => {
  it.each(recordFixtures)("reads back the document of %s", async (name) => {
    const doc = buildDocument(await parsedRecord(name), {
      canonicalOrigin: "https://whichlei.com",
    });
    expect(parseDocument(JSON.stringify(doc))).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it("is null for what is not a document", async () => {
    const doc = buildDocument(await parsedRecord("record-ericsson"), {
      canonicalOrigin: "https://whichlei.com",
    });
    const without = (key: string) => {
      const copy: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
      delete copy[key];
      return JSON.stringify(copy);
    };
    for (const text of [
      "",
      "null",
      "[]",
      "42",
      '"x"',
      "{}",
      "<html>an old cached page</html>",
      '{"lei":"X"}',
      without("url"),
      without("legalName"),
      without("source"),
      without("directParent"),
      without("otherNames"),
    ]) {
      expect(parseDocument(text), text.slice(0, 40)).toBeNull();
    }
  });
});

describe("documentUrl", () => {
  it("is the origin, /lei/ and the LEI, encoded", () => {
    expect(documentUrl("https://whichlei.com", ERICSSON)).toBe(
      `https://whichlei.com/lei/${ERICSSON}`,
    );
    expect(documentUrl("https://whichlei.com", "a/b?c")).toBe("https://whichlei.com/lei/a%2Fb%3Fc");
  });
});
