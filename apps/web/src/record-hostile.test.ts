// Every string GLEIF sends is untrusted. This fills every string field of a record with
// markup and checks that none of it reaches the page as markup.
import type { Address, LeiRecord } from "@whichlei/gleif";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.ts";
import { escapeMarkdown, markdownUrl, renderMarkdown } from "./markdown.ts";
import { renderMessagePage, renderRecordPage } from "./record.ts";
import { buildDocument } from "./record-document.ts";

const h = (field: string) => `<x"'&>${field}`;

const address = (name: string): Address => ({
  language: h(`${name}.language`),
  lines: [h(`${name}.line1`), h(`${name}.line2`)],
  number: h(`${name}.number`),
  numberWithinBuilding: h(`${name}.within`),
  mailRouting: h(`${name}.routing`),
  city: h(`${name}.city`),
  region: h(`${name}.region`),
  country: h(`${name}.country`),
  postalCode: h(`${name}.postal`),
});

// `kind` fields are GLEIF-independent discriminators, not free text.
const hostile: LeiRecord = {
  lei: h("lei"),
  legalName: { name: h("legalName"), language: h("legalName.language") },
  otherNames: [
    {
      name: h("other.name"),
      language: h("other.language"),
      kind: "trading",
      type: h("other.type"),
    },
  ],
  entityStatus: h("entityStatus"),
  registrationStatus: h("registrationStatus"),
  legalAddress: address("legal"),
  headquartersAddress: address("hq"),
  registrationAuthority: { id: h("authority.id"), other: h("authority.other") },
  registerNumber: h("registerNumber"),
  legalForm: { code: h("form.code"), other: h("form.other") },
  jurisdiction: h("jurisdiction"),
  category: h("category"),
  subCategory: h("subCategory"),
  creationDate: h("creationDate"),
  initialRegistrationDate: h("initialRegistrationDate"),
  lastUpdateDate: h("lastUpdateDate"),
  nextRenewalDate: h("nextRenewalDate"),
  corroborationLevel: h("corroborationLevel"),
  managingLou: h("managingLou"),
  expiration: { date: h("expiration.date"), reason: h("expiration.reason") },
  successors: [
    { lei: h("successor.lei"), name: h("successor.name") },
    { lei: null, name: h("successor2.name") },
    { lei: h("successor3.lei"), name: null },
  ],
  bics: [h("bic1"), h("bic2")],
  directParent: { kind: "exception", reason: h("direct.reason"), reference: h("direct.reference") },
  ultimateParent: { kind: "reported", lei: h("ultimate.lei") },
  source: {
    apiUrl: h("source.apiUrl"),
    webUrl: h("source.webUrl"),
    goldenCopyDate: h("goldenCopyDate"),
  },
};

// The names of codes and of linked entities are GLEIF's text too.
const context = {
  canonicalOrigin: "https://whichlei.test",
  codes: {
    elf: { [h("form.code")]: h("form.name") },
    ra: { [h("authority.id")]: h("authority.name") },
  },
  names: new Map([
    [h("ultimate.lei"), h("ultimate.name")],
    [h("successor3.lei"), h("successor3.name")],
  ]),
};
const page = renderRecordPage(hostile, context);
const jsonLd = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
const recordJson =
  /<script type="application\/json" id="record-json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
const outsideJsonLd = page
  .replace(/<script type="application\/ld\+json">.*?<\/script>/s, "")
  .replace(/<script type="application\/json" id="record-json">.*?<\/script>/s, "");

describe("a record whose every string is hostile", () => {
  it("lets no markup through outside JSON-LD", () => {
    expect(outsideJsonLd).not.toContain("<x");
    expect(outsideJsonLd).not.toContain(`"'&>`);
    // The only tags are the ones the template writes.
    const tags = new Set([...outsideJsonLd.matchAll(/<\/?([a-z][a-z0-9]*)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual([
      "a",
      "body",
      "button",
      "dd",
      "div",
      "dl",
      "dt",
      "h1",
      "head",
      "header",
      "html",
      "link",
      "main",
      "meta",
      "nav",
      "p",
      "script",
      "span",
      "time",
      "title",
    ]);
  });

  it("shows the fields it can, escaped", () => {
    const shown = [
      "legalName",
      "other.name",
      "other.language",
      "legal.line1",
      "legal.line2",
      "legal.number",
      "legal.within",
      "legal.routing",
      "legal.city",
      "legal.region",
      "legal.postal",
      "hq.line1",
      "hq.city",
      "registerNumber",
      "authority.id",
      "form.other",
      "form.code",
      "jurisdiction",
      "bic1",
      "bic2",
      "managingLou",
      "successor.name",
      "successor2.name",
      "ultimate.name",
      "ultimate.lei",
      "successor3.name",
      "authority.name",
    ];
    for (const field of shown) {
      expect(outsideJsonLd, field).toContain(escapeHtml(h(field)));
    }
    // LEIs in links are percent-encoded in the path and escaped in the text.
    for (const field of ["managingLou", "successor.lei", "successor3.lei", "ultimate.lei"]) {
      expect(outsideJsonLd, field).toContain(
        `href="/lei/${escapeHtml(encodeURIComponent(h(field)))}"`,
      );
    }
    expect(outsideJsonLd).toContain(`<span class="lei" id="lei">${escapeHtml(h("lei"))}</span>`);
  });

  it("drops a language code that is not one, and a source link that is not a URL", () => {
    expect(outsideJsonLd).not.toMatch(/lang="(?!en")/);
    expect(outsideJsonLd).not.toContain(`href="${escapeHtml(h("source.apiUrl"))}"`);
    expect(outsideJsonLd).not.toContain(`href="${escapeHtml(h("source.webUrl"))}"`);
    expect(jsonLd).not.toContain("sameAs");
  });

  it("puts everything in the JSON-LD data block as data", () => {
    const data = JSON.parse(jsonLd);
    expect(data.legalName).toBe(h("legalName"));
    expect(data.leiCode).toBe(h("lei"));
    expect(jsonLd).not.toContain("<");
    expect(jsonLd).not.toContain(">");
    expect(jsonLd).not.toContain("&");
  });

  it("puts the whole record in the JSON data block as data, for the copy json button", () => {
    expect(JSON.parse(recordJson)).toEqual(
      JSON.parse(JSON.stringify(buildDocument(hostile, context))),
    );
    expect(recordJson).not.toContain("<");
    expect(recordJson).not.toContain(">");
    expect(recordJson).not.toContain("&");
    expect(page.match(/<\/script>/g)).toHaveLength(4); // JSON-LD, the record, the copy and stats scripts
  });

  it("escapes a hostile message page", () => {
    const message = renderMessagePage({ title: h("t"), heading: h("h"), detail: h("d") });
    expect(message).not.toContain("<x");
  });
});

describe("a language code", () => {
  const withLanguage = (language: string | null) =>
    renderRecordPage(
      { ...hostile, legalName: { name: "N", language } },
      { canonicalOrigin: "https://whichlei.test" },
    );

  it("is kept when it has only letters, digits and hyphens", () => {
    expect(withLanguage("sv")).toContain('<span class="name" lang="sv">N</span>');
    expect(withLanguage("en-US")).toContain('lang="en-US"');
    expect(withLanguage("zh-Hant-TW")).toContain('lang="zh-Hant-TW"');
  });

  it("is dropped otherwise", () => {
    for (const bad of ['sv" onload="x', "sv en", "", "a".repeat(36), "s_v", "sv>"]) {
      expect(withLanguage(bad), bad).toContain('<span class="name">N</span>');
    }
    expect(withLanguage(null)).toContain('<span class="name">N</span>');
  });
});

describe("the same record as Markdown", () => {
  const origin = "https://whichlei.test";
  const markdown = renderMarkdown(buildDocument(hostile, context), origin);
  /** What a renderer sees as syntax: the text with every backslash-escaped character removed. */
  const syntax = (text: string) => text.replace(/\\./g, "");

  it("lets no markup through: every `<` and `[` GLEIF sent is escaped", () => {
    // The only `<` is the permalink's autolink; the only `[` start our own links.
    const bare = syntax(markdown);
    expect(bare.match(/</g)).toHaveLength(1);
    expect(bare).toContain(`permalink: <${origin}/lei/`);
    expect(bare).not.toContain("<x");
    expect(bare.match(/>/g)).toHaveLength(1);
    // The managing LOU, the ultimate parent and two successors: all with an LEI.
    expect(bare.match(/\[/g)).toHaveLength(4);
    expect(markdown).toContain("\\<x\"'&\\>legalName");
  });

  it("builds each link from our own origin, with a destination that cannot end it", () => {
    const destinations = [...markdown.matchAll(/\]\(([^)]*)\)/g)].map((match) => match[1] ?? "");
    expect(destinations).toHaveLength(4);
    for (const destination of destinations) {
      expect(destination).toMatch(/^https:\/\/whichlei\.test\/lei\/[A-Za-z0-9%.]+$/);
    }
    expect(destinations).toContain(
      markdownUrl(`${origin}/lei/${encodeURIComponent(h("successor.lei"))}`),
    );
  });

  it("shows the names it was given, escaped", () => {
    for (const field of ["ultimate.name", "successor3.name", "authority.name", "legalName"]) {
      expect(markdown, field).toContain(escapeMarkdown(h(field)));
    }
  });

  it("does not link the source when it is not an http(s) URL", () => {
    expect(markdown).toContain("Source: GLEIF API · golden copy");
  });

  it("keeps a line break in a name from starting a new block", () => {
    const record = structuredClone(hostile);
    record.legalName.name =
      "Evil\n# Heading\n- **status:** hacked\n1. first\n[click](https://evil.example)\n> quote\n```";
    record.otherNames = [
      { name: "A\r\n---", language: "en", kind: "trading", type: "TRADING_OR_OPERATING_NAME" },
      { name: "B\u2028# two", language: null, kind: "trading", type: "TRADING_OR_OPERATING_NAME" },
    ];
    const text = renderMarkdown(buildDocument(record, context), origin);
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("#"))).toHaveLength(1);
    expect(lines[0]).toMatch(/^# Evil \\# Heading /);
    for (const line of lines.slice(1)) {
      expect(line, line).toMatch(/^(LEI: |- \*\*[a-z ]+:\*\*| {2}- |Source: |$)/);
    }
    expect(syntax(text)).not.toContain("[click]");
    expect(syntax(text)).not.toContain("```");
  });

  it("keeps a bare address in a name from becoming a link", () => {
    const record = structuredClone(hostile);
    record.legalName.name = "Pay at https://evil.example or www.evil.example or a@evil.example";
    const text = renderMarkdown(buildDocument(record, context), origin);
    const heading = text.split("\n")[0] ?? "";
    expect(heading).toBe(
      "# Pay at https\\://evil.example or www\\.evil.example or a\\@evil.example",
    );
  });
});

describe("escapeMarkdown", () => {
  it.each([
    ["a*b_c", "a\\*b\\_c"],
    ["[x](y)", "\\[x\\]\\(y\\)"],
    ["# h", "\\# h"],
    ["<b>&</b>", "\\<b\\>&\\</b\\>"],
    ["`code`", "\\`code\\`"],
    ["a | b", "a \\| b"],
    ["back\\slash", "back\\\\slash"],
    ["- item", "\\- item"],
    ["+ item", "\\+ item"],
    ["1. item", "1\\. item"],
    ["12) item", "12\\) item"],
  ])("%j becomes %j", (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it("leaves what is no markup alone", () => {
    for (const plain of [
      "AT&T Inc.",
      "Société Générale S.A.",
      "556016-0680",
      "12.345.678",
      "-5",
      "+46 8 1",
    ]) {
      expect(escapeMarkdown(plain), plain).toBe(plain);
    }
  });
});

describe("markdownUrl", () => {
  it("encodes everything that could end or change a link", () => {
    expect(markdownUrl("https://a.test/x y(1)[2]<3>\"'`\\")).toBe(
      "https://a.test/x%20y%281%29%5B2%5D%3C3%3E%22%27%60%5C",
    );
    expect(markdownUrl("https://a.test/lei/%3Cx")).toBe("https://a.test/lei/%3Cx");
    expect(markdownUrl("https://a.test/å")).toBe("https://a.test/%C3%A5");
  });

  it("copes with a lone surrogate", () => {
    expect(markdownUrl("https://a.test/\ud800")).toBe("https://a.test/%EF%BF%BD");
  });
});
