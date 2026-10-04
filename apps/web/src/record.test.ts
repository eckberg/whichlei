import { describe, expect, it } from "vitest";
import { escapeHtml, html } from "./html.ts";
import {
  renderDocumentPage,
  renderMessagePage,
  renderPage,
  renderRecordPage,
  socialTags,
  statusOf,
} from "./record.ts";
import { buildDocument } from "./record-document.ts";
import { leiOf, parsedRecord, recordFixtures } from "./test-helpers.ts";

const context = { canonicalOrigin: "https://whichlei.test" };

const title = (page: string) => /<title>(.*?)<\/title>/s.exec(page)?.[1];
const field = (page: string, name: string) =>
  new RegExp(`<dd data-field="${name}">(.*?)</dd>`, "s").exec(page)?.[1];
const text = (markup: string | undefined) => markup?.replace(/<[^>]*>/g, "");

const STATUS: Record<string, string> = {
  "record-lapsed": "lapsed",
  "record-retired": "inactive",
};

describe("every recorded fixture", () => {
  it("covers the fixtures we have", () => {
    expect(recordFixtures).toHaveLength(9);
  });

  it.each(recordFixtures)(
    "%s renders its title, LEI, name, status and source date",
    async (name) => {
      const record = await parsedRecord(name);
      const page = renderRecordPage(record, context);

      expect(title(page)).toBe(
        escapeHtml(`${record.legalName.name} · LEI ${record.lei} · whichlei`),
      );
      expect(record.lei).toBe(leiOf(name));
      // One heading holds the LEI and the name, so the name is part of what a crawler reads.
      expect(page).toContain(`<h1 class="title"><span class="lei" id="lei">${record.lei}</span>\n`);
      expect(page).toMatch(
        new RegExp(
          `<span class="name"[^>]*>${escapeHtml(record.legalName.name).replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}</span></h1>`,
        ),
      );
      expect(text(field(page, "status"))).toContain(STATUS[name] ?? "active");
      expect(page).toContain('<time data-field="golden-copy">2026-09-30</time>');
      expect(page).toContain(`href="https://api.gleif.org/api/v1/lei-records/${record.lei}`);
      expect(page).toContain(`href="https://search.gleif.org/#/record/${record.lei}"`);
      expect(page).toContain(
        `<link rel="canonical" href="https://whichlei.test/lei/${record.lei}">`,
      );
      expect(page).toContain(`data-copy="${record.lei}" hidden`);
      expect(page).toMatch(
        /<meta name="description" content="[^"]+GLEIF, golden copy 2026-09-30\.">/,
      );
      expect(page).toContain('<link rel="stylesheet" href="/styles/record.css">');
      // Fonts come from the site (styles/record.css), not from a font host.
      expect(page).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(page.startsWith("<!doctype html>")).toBe(true);
    },
  );

  it.each(recordFixtures)("%s carries JSON-LD with the LEI", async (name) => {
    const record = await parsedRecord(name);
    const page = renderRecordPage(record, context);
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
    const data = JSON.parse(json);
    expect(data["@type"]).toBe("Organization");
    expect(data["@context"]).toBe("https://schema.org");
    expect(data.leiCode).toBe(record.lei);
    expect(data.legalName).toBe(record.legalName.name);
    expect(data["@id"]).toBe(`https://whichlei.test/lei/${record.lei}`);
    expect(data).not.toHaveProperty("url");
    expect(json).not.toContain("<");
  });
});

describe("head", () => {
  const meta = (page: string, attribute: string, key: string) =>
    new RegExp(`<meta ${attribute}="${key}" content="([^"]*)">`).exec(page)?.[1];

  it.each(recordFixtures)("%s has icons and social tags", async (name) => {
    const record = await parsedRecord(name);
    const page = renderRecordPage(record, context);
    const url = `https://whichlei.test/lei/${record.lei}`;
    expect(page).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    // The JSON and Markdown URLs are not linked: they would invite crawlers to fetch three
    // URLs per record.
    expect(page).not.toContain('rel="alternate"');
    expect(meta(page, "property", "og:type")).toBe("website");
    expect(meta(page, "property", "og:site_name")).toBe("whichlei");
    expect(meta(page, "property", "og:title")).toBe(title(page));
    expect(meta(page, "property", "og:description")).toBe(meta(page, "name", "description"));
    expect(meta(page, "property", "og:url")).toBe(url);
    expect(meta(page, "property", "og:image")).toBe("https://whichlei.test/icon-512.png");
    expect(meta(page, "name", "twitter:card")).toBe("summary");
  });

  it("escapes what GLEIF sent in the social tags", async () => {
    const record = await parsedRecord("record-ericsson");
    record.legalName.name = '"><script>x</script>';
    const page = renderRecordPage(record, context);
    expect(page).not.toContain("<script>x");
    expect(meta(page, "property", "og:title")).toContain("&quot;&gt;&lt;script&gt;");
    expect(meta(page, "property", "og:description")).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("gives the icons to the message pages too, and no social tags", () => {
    const page = renderMessagePage({ title: "t", heading: "h", detail: "d" });
    expect(page).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32">');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(page).not.toContain("og:");
  });

  it("leaves the URL and the image out of the social tags when there is no origin", () => {
    const tags = socialTags({ title: "T", description: "D", origin: "", url: null }).value;
    expect(tags).toContain('<meta property="og:title" content="T">');
    expect(tags).toContain('<meta name="twitter:card" content="summary">');
    expect(tags).not.toContain("og:url");
    expect(tags).not.toContain("og:image");
  });

  it("is a shell that takes any body, with scripts only when asked", () => {
    const page = renderPage({ title: "T", body: html`<main>x</main>` });
    expect(page).toContain("<title>T</title>");
    expect(page).toContain("<main>x</main>");
    expect(page).not.toContain("<script");
    expect(renderPage({ title: "T", body: html``, scripts: true })).toContain("copy.js");
  });
});

describe("JSON-LD links and identifiers", () => {
  const ld = (page: string) =>
    JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "");
  const PARENT = "549300W9JLPW15XIFM52";

  it("names a reported parent by its LEI, and by its name when it is known", async () => {
    const record = await parsedRecord("record-subsidiary");
    expect(ld(renderRecordPage(record, context)).parentOrganization).toEqual({
      "@type": "Organization",
      "@id": `https://whichlei.test/lei/${PARENT}`,
      leiCode: PARENT,
    });
    const named = renderRecordPage(record, {
      ...context,
      names: new Map([[PARENT, "Telefonaktiebolaget LM Ericsson"]]),
    });
    expect(ld(named).parentOrganization).toEqual({
      "@type": "Organization",
      "@id": `https://whichlei.test/lei/${PARENT}`,
      leiCode: PARENT,
      name: "Telefonaktiebolaget LM Ericsson",
    });
  });

  it("has no parent organization when none is reported", async () => {
    for (const name of ["record-ericsson", "record-branch"]) {
      const data = ld(renderRecordPage(await parsedRecord(name), context));
      expect(data, name).not.toHaveProperty("parentOrganization");
    }
  });

  it("lists each BIC, and the register number under the register's id", async () => {
    const data = ld(renderRecordPage(await parsedRecord("record-ericsson"), context));
    expect(data.identifier).toEqual([
      { "@type": "PropertyValue", propertyID: "BIC", value: "TEERSESSXXX" },
      { "@type": "PropertyValue", propertyID: "RA000544", value: "556016-0680" },
    ]);
  });

  it("lists only what the record has", async () => {
    const subsidiary = ld(renderRecordPage(await parsedRecord("record-subsidiary"), context));
    expect(subsidiary.identifier).toEqual([
      { "@type": "PropertyValue", propertyID: "RA000602", value: "4437638" },
    ]);
    // A register number without the register's id is not an identifier anyone can use.
    const record = await parsedRecord("record-ericsson");
    record.bics = [];
    record.registrationAuthority = { id: null, other: "Some register" };
    expect(ld(renderRecordPage(record, context))).not.toHaveProperty("identifier");
  });

  it("keeps a hostile name, BIC and parent from closing the script", async () => {
    const record = await parsedRecord("record-subsidiary");
    record.bics = ["</script><b>&"];
    const page = renderRecordPage(record, {
      ...context,
      names: new Map([[PARENT, "</script><i>&"]]),
    });
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
    expect(json).not.toMatch(/[<>&]/);
    expect(JSON.parse(json).parentOrganization.name).toBe("</script><i>&");
    expect(JSON.parse(json).identifier[0].value).toBe("</script><b>&");
  });
});

describe("fields", () => {
  it("links parents to their own pages", async () => {
    const page = renderRecordPage(await parsedRecord("record-subsidiary"), context);
    const parent = "549300W9JLPW15XIFM52";
    expect(field(page, "parent")).toBe(`<a href="/lei/${parent}">${parent}</a>`);
    expect(field(page, "ultimate-parent")).toBe(`<a href="/lei/${parent}">${parent}</a>`);
  });

  it("says why there is no parent", async () => {
    const page = renderRecordPage(await parsedRecord("record-ericsson"), context);
    expect(text(field(page, "parent"))).toBe("none: no known person");
    const branch = renderRecordPage(await parsedRecord("record-branch"), context);
    expect(text(field(branch, "parent"))).toBe("none reported");
    expect(field(branch, "ultimate-parent")).toBeUndefined();
  });

  it("shows a successor by name when GLEIF gives no LEI", async () => {
    const page = renderRecordPage(await parsedRecord("record-retired"), context);
    expect(text(field(page, "successors"))).toBe("Bolagsstiftarna Sirga AB");
    expect(text(field(page, "other-names"))).toContain("Rågårds i Karlskrona Aktiebolag");
    expect(text(field(page, "other-names"))).toContain("previous");
  });

  it("links the managing LOU to its own page", async () => {
    const page = renderRecordPage(await parsedRecord("record-ericsson"), context);
    const lou = "549300O897ZC5H7CY412";
    expect(field(page, "managing-lou")).toBe(`<a href="/lei/${lou}">${lou}</a>`);
  });

  it("leaves previous names out of the JSON-LD alternate names, and keeps trading names", async () => {
    const previous = await parsedRecord("record-retired");
    expect(previous.otherNames.map((n) => n.kind)).toEqual(["previous"]);
    const ld = (page: string) =>
      JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "");
    expect(ld(renderRecordPage(previous, context))).not.toHaveProperty("alternateName");

    const mixed = await parsedRecord("record-toyota");
    mixed.otherNames.push({ name: "Old Name", language: "en", kind: "previous", type: "PREVIOUS" });
    mixed.otherNames.push({ name: "Toyota", language: "en", kind: "trading", type: "TRADING" });
    expect(ld(renderRecordPage(mixed, context)).alternateName).toEqual([
      "Toyota Motor Corporation",
      "Toyota",
    ]);
  });

  it("links a successor that has an LEI", async () => {
    const record = await parsedRecord("record-retired", (body) => {
      const entity = (
        body as { data: { attributes: { entity: { successorEntities: unknown[] } } } }
      ).data.attributes.entity;
      entity.successorEntities = [{ lei: "549300W9JLPW15XIFM52", name: "Ericsson" }];
      return body;
    });
    const page = renderRecordPage(record, context);
    expect(field(page, "successors")).toContain('<a href="/lei/549300W9JLPW15XIFM52">Ericsson</a>');
  });

  it("shows the headquarters only when it differs from the legal address", async () => {
    const same = renderRecordPage(await parsedRecord("record-ericsson"), context);
    expect(field(same, "hq-address")).toBeUndefined();
    const differs = renderRecordPage(await parsedRecord("record-subsidiary"), context);
    expect(text(field(differs, "legal-address"))).toContain("251 LITTLE FALLS DRIVE");
    expect(text(field(differs, "hq-address"))).toContain("Holmdel");
  });

  it("marks up a foreign name and the alternative-language name", async () => {
    const page = renderRecordPage(await parsedRecord("record-toyota"), context);
    expect(page).toContain('<span class="name" lang="ja">トヨタ自動車株式会社</span></h1>');
    expect(field(page, "other-names")).toContain("Toyota Motor Corporation");
    expect(field(page, "other-names")).toContain("alternative language");
  });

  it("shows status and renewal for an active record", async () => {
    const page = renderRecordPage(await parsedRecord("record-ericsson"), context);
    expect(field(page, "status")).toBe('<span class="st-active">active</span>');
    expect(text(field(page, "registration"))).toBe("issued · renews 2027-09-12");
    expect(text(field(page, "register"))).toBe("556016-0680 RA000544");
    expect(text(field(page, "bic"))).toBe("TEERSESSXXX");
  });

  it("names the state of a lapsed and of a retired record", async () => {
    const lapsed = await parsedRecord("record-lapsed");
    expect(statusOf(lapsed)).toEqual({ label: "lapsed", tone: "lapsed" });
    const retired = await parsedRecord("record-retired");
    expect(statusOf(retired)).toEqual({ label: "inactive", tone: "retired" });
  });
});

describe("names of linked entities", () => {
  const PARENT = "549300W9JLPW15XIFM52";
  const names = new Map([[PARENT, "Telefonaktiebolaget LM Ericsson"]]);

  it("shows a parent by name, with its LEI beside it", async () => {
    const page = renderRecordPage(await parsedRecord("record-subsidiary"), { ...context, names });
    const expected = `<a href="/lei/${PARENT}">Telefonaktiebolaget LM Ericsson</a> <span class="none">${PARENT}</span>`;
    expect(field(page, "parent")).toBe(expected);
    expect(field(page, "ultimate-parent")).toBe(expected);
  });

  it("shows the LEI as the link when the name is not known", async () => {
    const record = await parsedRecord("record-subsidiary");
    for (const given of [undefined, null, new Map(), new Map([["OTHER", "Other AB"]])]) {
      const page = renderRecordPage(record, { ...context, names: given });
      expect(field(page, "parent"), String(given)).toBe(`<a href="/lei/${PARENT}">${PARENT}</a>`);
    }
  });

  it("names a successor that GLEIF gave only an LEI for", async () => {
    const record = await parsedRecord("record-retired", (body) => {
      const entity = (
        body as { data: { attributes: { entity: { successorEntities: unknown[] } } } }
      ).data.attributes.entity;
      entity.successorEntities = [{ lei: PARENT, name: null }];
      return body;
    });
    const bare = renderRecordPage(record, context);
    expect(field(bare, "successors")).toBe(`<div><a href="/lei/${PARENT}">${PARENT}</a></div>`);
    const named = renderRecordPage(record, { ...context, names });
    expect(field(named, "successors")).toBe(
      `<div><a href="/lei/${PARENT}">Telefonaktiebolaget LM Ericsson</a> <span class="none">${PARENT}</span></div>`,
    );
  });

  it("keeps GLEIF's own name for a successor", async () => {
    const record = await parsedRecord("record-retired", (body) => {
      const entity = (
        body as { data: { attributes: { entity: { successorEntities: unknown[] } } } }
      ).data.attributes.entity;
      entity.successorEntities = [{ lei: PARENT, name: "Ericsson, as GLEIF has it" }];
      return body;
    });
    const page = renderRecordPage(record, { ...context, names });
    expect(field(page, "successors")).toContain(">Ericsson, as GLEIF has it</a>");
    expect(field(page, "successors")).not.toContain("Telefonaktiebolaget");
  });

  it("leaves the managing LOU as its LEI: it is not looked up", async () => {
    const lou = "549300O897ZC5H7CY412";
    const page = renderRecordPage(await parsedRecord("record-ericsson"), {
      ...context,
      names: new Map([[lou, "Nordic Legal Entity Identifier AB"]]),
    });
    expect(field(page, "managing-lou")).toBe(`<a href="/lei/${lou}">${lou}</a>`);
  });

  it("escapes a name", async () => {
    const page = renderRecordPage(await parsedRecord("record-subsidiary"), {
      ...context,
      names: new Map([[PARENT, '<img src=x onerror=alert(1)>"']]),
    });
    expect(page).not.toContain("<img");
    expect(field(page, "parent")).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;</a>");
  });
});

describe("names for codes", () => {
  const codes = {
    elf: { XJHM: "Aktiebolag", "2HBR": "Gesellschaft mit beschränkter Haftung" },
    ra: { RA000544: "Bolagsverket" },
  };

  it("shows the legal form and the register by name, with the code beside it", async () => {
    const page = renderRecordPage(await parsedRecord("record-ericsson"), { ...context, codes });
    expect(text(field(page, "legal-form"))).toBe("Aktiebolag XJHM");
    expect(field(page, "legal-form")).toBe('Aktiebolag <span class="none">XJHM</span>');
    expect(text(field(page, "register"))).toBe("556016-0680 Bolagsverket · RA000544");
  });

  it("shows the code alone when the names lack it, or there are no names", async () => {
    const record = await parsedRecord("record-ericsson");
    for (const given of [undefined, null, { elf: {}, ra: {} }]) {
      const page = renderRecordPage(record, { ...context, codes: given });
      expect(text(field(page, "legal-form"))).toBe("XJHM");
      expect(text(field(page, "register"))).toBe("556016-0680 RA000544");
    }
  });

  it("names the form of a record whose form has a name and a register that has none", async () => {
    const page = renderRecordPage(await parsedRecord("record-exception"), { ...context, codes });
    expect(text(field(page, "legal-form"))).toBe("Gesellschaft mit beschränkter Haftung 2HBR");
    expect(text(field(page, "register"))).toContain("RA000279");
    expect(text(field(page, "register"))).not.toContain("·");
  });

  it("prefers GLEIF's own text for a form that is 'other' to a name from the codes", async () => {
    const record = await parsedRecord("record-fund");
    expect(record.legalForm.code).toBe("8888");
    const page = renderRecordPage(record, { ...context, codes: { ...codes, elf: { 8888: "x" } } });
    expect(text(field(page, "legal-form"))).toBe(record.legalForm.other ?? "x");
    expect(text(field(page, "legal-form"))).not.toContain("8888 ");
  });

  it("escapes a name", async () => {
    const page = renderRecordPage(await parsedRecord("record-ericsson"), {
      ...context,
      codes: { elf: { XJHM: "<b>AB</b>" }, ra: { RA000544: '"><i>' } },
    });
    expect(page).not.toContain("<b>");
    expect(page).not.toContain("<i>");
    expect(page).toContain("&lt;b&gt;AB&lt;/b&gt;");
  });
});

describe("the record document", () => {
  const block = (page: string) =>
    /<script type="application\/json" id="record-json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
  const codes = { elf: { XJHM: "Aktiebolag" }, ra: { RA000544: "Bolagsverket" } };
  const PARENT = "549300W9JLPW15XIFM52";

  it("is the record, with the page's URL after the LEI", async () => {
    const record = await parsedRecord("record-ericsson");
    const doc = buildDocument(record, context);
    expect(Object.keys(doc).slice(0, 3)).toEqual(["lei", "url", "legalName"]);
    expect(doc.url).toBe(`https://whichlei.test/lei/${record.lei}`);
    // Nothing else is added when there are no names.
    const { url, ...rest } = JSON.parse(JSON.stringify(doc));
    expect(url).toBe(doc.url);
    expect(rest).toEqual(JSON.parse(JSON.stringify(record)));
    expect(Object.keys(rest)).toEqual(Object.keys(record));
  });

  it("adds the names of the legal form and the register, and of the parents", async () => {
    const record = await parsedRecord("record-subsidiary");
    const doc = buildDocument(record, {
      ...context,
      codes: {
        elf: { XTIQ: "Corporation" },
        ra: { RA000602: "Delaware Division of Corporations" },
      },
      names: new Map([[PARENT, "Telefonaktiebolaget LM Ericsson"]]),
    });
    expect(doc.legalForm).toEqual({ code: "XTIQ", other: null, name: "Corporation" });
    expect(doc.registrationAuthority).toEqual({
      id: "RA000602",
      other: null,
      name: "Delaware Division of Corporations",
    });
    const named = { kind: "reported", lei: PARENT, name: "Telefonaktiebolaget LM Ericsson" };
    expect(doc.directParent).toEqual(named);
    expect(doc.ultimateParent).toEqual(named);
    // The record itself is not changed.
    expect(record.directParent).toEqual({ kind: "reported", lei: PARENT });
    expect(record.legalForm).not.toHaveProperty("name");
  });

  it("gives no name to what has none: unknown codes, exceptions, a form GLEIF describes itself", async () => {
    const ericsson = buildDocument(await parsedRecord("record-ericsson"), {
      ...context,
      codes: { elf: {}, ra: {} },
      names: new Map([[PARENT, "x"]]),
    });
    expect(ericsson.legalForm).not.toHaveProperty("name");
    expect(ericsson.registrationAuthority).not.toHaveProperty("name");
    expect(ericsson.directParent).toEqual({
      kind: "exception",
      reason: "NO_KNOWN_PERSON",
      reference: null,
    });
    const fund = buildDocument(await parsedRecord("record-fund"), {
      ...context,
      codes: { elf: { 8888: "OTHER" }, ra: {} },
    });
    expect(fund.legalForm).toEqual({ code: "8888", other: "FUND" });
  });

  it("does not take a name from the codes' prototype", async () => {
    const record = await parsedRecord("record-ericsson");
    record.legalForm = { code: "constructor", other: null };
    record.registrationAuthority = { id: "toString", other: null };
    const doc = buildDocument(record, { ...context, codes });
    expect(doc.legalForm).toEqual({ code: "constructor", other: null });
    expect(doc.registrationAuthority).toEqual({ id: "toString", other: null });
  });

  it("fills a successor's name when GLEIF left it out, and keeps one it gave", async () => {
    const record = await parsedRecord("record-retired");
    record.successors = [
      { lei: PARENT, name: null },
      { lei: "549300O897ZC5H7CY412", name: "Given" },
      { lei: null, name: "No LEI" },
    ];
    const doc = buildDocument(record, {
      ...context,
      names: new Map([
        [PARENT, "Looked up"],
        ["549300O897ZC5H7CY412", "Looked up too"],
      ]),
    });
    expect(doc.successors.map((successor) => successor.name)).toEqual([
      "Looked up",
      "Given",
      "No LEI",
    ]);
  });

  it.each(recordFixtures)("%s is embedded for copy json, with a button for it", async (name) => {
    const record = await parsedRecord(name);
    const doc = buildDocument(record, { ...context, codes });
    const page = renderDocumentPage(doc, "https://whichlei.test");
    expect(JSON.parse(block(page))).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(page).toContain(
      '<button class="btn" type="button" data-copy-json="record-json" hidden>copy json</button>',
    );
  });

  it("is what a page makes from a record: the same page either way", async () => {
    const record = await parsedRecord("record-ericsson");
    expect(
      renderDocumentPage(buildDocument(record, { ...context, codes }), context.canonicalOrigin),
    ).toBe(renderRecordPage(record, { ...context, codes }));
  });

  it("keeps a name from closing the data block", async () => {
    const record = await parsedRecord("record-ericsson");
    record.legalName.name = "</script><b>&";
    const json = block(renderRecordPage(record, context));
    expect(json).not.toMatch(/[<>&]/);
    expect(JSON.parse(json).legalName.name).toBe("</script><b>&");
  });

  it("has no copy button on a page with no record", () => {
    const page = renderMessagePage({ title: "t", heading: "h", detail: "d" });
    expect(page).not.toContain("copy json");
  });
});

describe("escaping", () => {
  const hostile = `<script>alert("x")</script> & 'quote' </title><img src=x onerror=alert(1)>`;

  async function hostilePage() {
    const record = await parsedRecord("record-ericsson", (body) => {
      const entity = (
        body as {
          data: { attributes: { entity: Record<string, unknown> } };
        }
      ).data.attributes.entity;
      entity.legalName = { name: hostile, language: 'sv" onload="x' };
      entity.otherNames = [{ name: hostile, language: "en", type: "TRADING_OR_OPERATING_NAME" }];
      entity.legalAddress = { addressLines: [hostile], city: hostile, country: "SE" };
      entity.registeredAs = hostile;
      entity.legalForm = { id: "8888", other: hostile };
      return body;
    });
    return renderRecordPage(record, context);
  }

  it("never lets a legal name, address or form become markup", async () => {
    const page = await hostilePage();
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("</title><");
    expect(page).not.toContain('onload="x');
    expect(page).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;",
    );
    expect(title(page)).toContain("&lt;/title&gt;");
  });

  it("keeps the name from closing the JSON-LD script", async () => {
    const page = await hostilePage();
    const scripts = page.match(/<script\b/g) ?? [];
    expect(scripts).toHaveLength(4); // JSON-LD, the record as JSON, the copy and stats scripts
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
    expect(JSON.parse(json).name).toBe(hostile);
    expect(json).not.toContain("<");
  });

  it("only links http(s) source URLs", async () => {
    const record = await parsedRecord("record-ericsson");
    record.source.apiUrl = 'javascript:alert("x")';
    const page = renderRecordPage(record, context);
    // The record's JSON, a data block that nothing runs, still holds what GLEIF sent.
    const visible = page.replace(/<script type="application\/json".*?<\/script>/s, "");
    expect(visible).not.toContain("javascript:");
    expect(page).toContain("source: GLEIF API ·");
  });

  it("escapes a LEI in a link", async () => {
    const record = await parsedRecord("record-subsidiary");
    record.directParent = { kind: "reported", lei: '"><b>' };
    const page = renderRecordPage(record, context);
    expect(page).not.toContain("<b>");
    expect(page).toContain('href="/lei/%22%3E%3Cb%3E"');
  });
});

describe("renderMessagePage", () => {
  it("renders a short page and escapes it", () => {
    const page = renderMessagePage({ title: "<t>", heading: "<h>", detail: "<d>" });
    expect(page).toContain("<title>&lt;t&gt; · whichlei</title>");
    expect(page).toContain("<h1>&lt;h&gt;</h1>");
    expect(page).not.toContain("<d>");
    expect(page).toContain('<a class="btn" href="/">search</a>');
  });

  it("does not load the copy or stats script, which a record page does", async () => {
    const message = renderMessagePage({ title: "t", heading: "h", detail: "d" });
    expect(message).not.toContain("<script");
    const page = renderRecordPage(await parsedRecord("record-ericsson"), context);
    expect(page).toContain('<script src="/scripts/copy.js" defer></script>');
    expect(page).toContain('<script src="/scripts/stats.js" defer></script>');
    // The search counter is in app.js, which a record page does not load: no event is sent
    // from a record page, where Fathom would give it the path /lei/<LEI>.
    expect(page).not.toContain("/app.js");
  });
});
