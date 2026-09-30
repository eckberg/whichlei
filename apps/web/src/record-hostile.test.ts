// Every string GLEIF sends is untrusted. This fills every string field of a record with
// markup and checks that none of it reaches the page as markup.
import type { Address, LeiRecord } from "@whichlei/gleif";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.ts";
import { renderMessagePage, renderRecordPage } from "./record.ts";

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

const page = renderRecordPage(hostile, { canonicalOrigin: "https://whichlei.test" });
const jsonLd = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
const outsideJsonLd = page.replace(/<script type="application\/ld\+json">.*?<\/script>/s, "");

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
      "ultimate.lei",
    ];
    for (const field of shown) {
      expect(outsideJsonLd, field).toContain(escapeHtml(h(field)));
    }
    // LEIs in links are percent-encoded in the path and escaped in the text.
    for (const field of ["managingLou", "successor.lei", "ultimate.lei"]) {
      expect(outsideJsonLd, field).toContain(
        `href="/lei/${escapeHtml(encodeURIComponent(h(field)))}"`,
      );
    }
    expect(outsideJsonLd).toContain(`<h1 class="lei" id="lei">${escapeHtml(h("lei"))}</h1>`);
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
    expect(withLanguage("sv")).toContain('<div class="name" lang="sv">N</div>');
    expect(withLanguage("en-US")).toContain('lang="en-US"');
    expect(withLanguage("zh-Hant-TW")).toContain('lang="zh-Hant-TW"');
  });

  it("is dropped otherwise", () => {
    for (const bad of ['sv" onload="x', "sv en", "", "a".repeat(36), "s_v", "sv>"]) {
      expect(withLanguage(bad), bad).toContain('<div class="name">N</div>');
    }
    expect(withLanguage(null)).toContain('<div class="name">N</div>');
  });
});
