import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCodes } from "./codes.ts";
import { renderMarkdown, renderMarkdownMessage } from "./markdown.ts";
import { renderDocumentPage } from "./record.ts";
import { buildDocument } from "./record-document.ts";
import { parsedRecord, recordFixtures } from "./test-helpers.ts";

const origin = "https://whichlei.com";
const codes = parseCodes(
  JSON.parse(readFileSync(new URL("../fixtures/codes.json", import.meta.url), "utf8")),
);
const PARENT = "549300W9JLPW15XIFM52";

const markdownOf = async (fixture: string, names?: Map<string, string>) =>
  renderMarkdown(await documentOf(fixture, names), origin);
const documentOf = async (fixture: string, names?: Map<string, string>) =>
  buildDocument(await parsedRecord(fixture), { canonicalOrigin: origin, codes, names });

describe("renderMarkdown", () => {
  it("writes a listed company as a heading, the LEI, a list of rows and the source", async () => {
    expect(await markdownOf("record-ericsson")).toBe(`# Telefonaktiebolaget LM Ericsson

LEI: ${PARENT}

- **status:** active
- **registration:** issued · renews 2027-09-12
- **address:** Torshamnsgatan 21, 164 83 Stockholm, SE-AB
- **register:** 556016-0680 (Bolagsverket · RA000544)
- **legal form:** Aktiebolag (XJHM)
- **jurisdiction:** SE
- **category:** general
- **bic:** TEERSESSXXX
- **parent:** none: no known person
- **ultimate:** none: no known person
- **since:** 1918-08-19
- **registered:** 2013-09-16
- **updated:** 2026-07-16
- **corroboration:** fully corroborated
- **managed by:** [549300O897ZC5H7CY412](https://whichlei.com/lei/549300O897ZC5H7CY412)

Source: [GLEIF API](https://api.gleif.org/api/v1/lei-records/${PARENT}) · golden copy 2026-09-30 · permalink: <https://whichlei.com/lei/${PARENT}>
`);
  });

  it("links a parent by name with absolute URLs, and shows its LEI after it", async () => {
    const text = await markdownOf(
      "record-subsidiary",
      new Map([[PARENT, "Telefonaktiebolaget LM Ericsson"]]),
    );
    const link = `[Telefonaktiebolaget LM Ericsson](https://whichlei.com/lei/${PARENT}) (${PARENT})`;
    expect(text).toContain(`- **parent:** ${link}\n`);
    expect(text).toContain(`- **ultimate:** ${link}\n`);
    expect(text).toContain("- **headquarters:** 101 Crawfords Corner Road");
  });

  it("links a parent by its LEI when the name is not known", async () => {
    const text = await markdownOf("record-subsidiary");
    expect(text).toContain(`- **parent:** [${PARENT}](https://whichlei.com/lei/${PARENT})\n`);
  });

  it("lists several values under their row, one value on the row's line", async () => {
    const record = await parsedRecord("record-retired", (body) => {
      const entity = (
        body as { data: { attributes: { entity: { successorEntities: unknown[] } } } }
      ).data.attributes.entity;
      entity.successorEntities = [
        { lei: PARENT, name: null },
        { lei: null, name: "Bolagsstiftarna Sirga AB" },
      ];
      return body;
    });
    const text = renderMarkdown(
      buildDocument(record, {
        canonicalOrigin: origin,
        codes,
        names: new Map([[PARENT, "Ericsson"]]),
      }),
      origin,
    );
    expect(text).toContain(
      `- **successor:**\n  - [Ericsson](https://whichlei.com/lei/${PARENT}) (${PARENT})\n  - Bolagsstiftarna Sirga AB\n`,
    );
    // One other name: on the row's line.
    expect(text).toContain(
      "- **also known as:** Rågårds i Karlskrona Aktiebolag (previous · sv)\n",
    );
  });

  it("shows the end of an inactive entity, and says when the golden copy is not known", async () => {
    const record = await parsedRecord("record-retired");
    record.expiration = { date: "2026-03-01T00:00:00Z", reason: "DISSOLVED" };
    record.source.goldenCopyDate = null;
    const text = renderMarkdown(buildDocument(record, { canonicalOrigin: origin }), origin);
    expect(text).toContain("- **status:** inactive · ended 2026-03-01 (dissolved)\n");
    expect(text).toContain("golden copy unknown ·");
  });

  it.each(recordFixtures)("%s has the same rows as the page, in the same order", async (name) => {
    const doc = await documentOf(name);
    const labels = [...renderDocumentPage(doc, origin).matchAll(/<dt>(.*?)<\/dt>/g)].map(
      (m) => m[1],
    );
    const rows = [...renderMarkdown(doc, origin).matchAll(/^- \*\*(.*?):\*\*/gm)].map((m) => m[1]);
    expect(rows).toEqual(labels);
    expect(rows.length).toBeGreaterThan(5);
  });

  it.each(recordFixtures)(
    "%s is a heading, the LEI, then the list and the source",
    async (name) => {
      const doc = await documentOf(name);
      const lines = renderMarkdown(doc, origin).split("\n");
      expect(lines[0]).toMatch(/^# \S/);
      expect(lines[2]).toBe(`LEI: ${doc.lei}`);
      expect(lines.at(-2)).toMatch(
        /^Source: \[GLEIF API\]\(https:\/\/api\.gleif\.org\/.*\) · golden copy 2026-09-30 · permalink: <https:\/\/whichlei\.com\/lei\/[0-9A-Z]{20}>$/,
      );
      expect(lines.at(-1)).toBe("");
    },
  );
});

describe("renderMarkdownMessage", () => {
  it("is a heading and a paragraph", () => {
    expect(renderMarkdownMessage("No such LEI", "GLEIF has no record.")).toBe(
      "# No such LEI\n\nGLEIF has no record.\n",
    );
  });
});
