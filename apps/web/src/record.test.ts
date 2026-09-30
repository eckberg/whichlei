import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.ts";
import { renderMessagePage, renderRecordPage, statusOf } from "./record.ts";
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
      expect(page).toContain(`<h1 class="lei" id="lei">${record.lei}</h1>`);
      expect(page).toMatch(
        new RegExp(
          `<div class="name"[^>]*>${escapeHtml(record.legalName.name).replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}</div>`,
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
    expect(data.url).toBe(`https://whichlei.test/lei/${record.lei}`);
    expect(json).not.toContain("<");
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
    expect(page).toContain('<div class="name" lang="ja">トヨタ自動車株式会社</div>');
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
    expect(scripts).toHaveLength(2); // JSON-LD and the copy script
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1] ?? "";
    expect(JSON.parse(json).name).toBe(hostile);
    expect(json).not.toContain("<");
  });

  it("only links http(s) source URLs", async () => {
    const record = await parsedRecord("record-ericsson");
    record.source.apiUrl = 'javascript:alert("x")';
    const page = renderRecordPage(record, context);
    expect(page).not.toContain("javascript:");
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
});
