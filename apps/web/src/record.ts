// The record page: one LEI record as a server-rendered HTML document. A pure function of the
// record, so the search page can reuse it later. Every value goes through `html`, which
// escapes. The styles (fonts included) and the copy script are static assets (see scripts/build.ts).

import type { Address, LeiRecord, ParentLink } from "@whichlei/gleif";
import { type Html, html, raw } from "./html.ts";

export interface RecordPageContext {
  /** Origin of the canonical URL, such as `https://whichlei.com`, without a trailing slash. */
  canonicalOrigin: string;
}

const leiPath = (lei: string) => `/lei/${encodeURIComponent(lei)}`;

/** The date part of an ISO 8601 timestamp, `2026-09-30`. */
const day = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

/** GLEIF codes such as `NO_KNOWN_PERSON` and `FULLY_CORROBORATED`, in plain lower case. */
const words = (code: string): string => code.toLowerCase().replace(/[_-]/g, " ");

/** ` lang="sv"`, only when GLEIF's code looks like a language code. */
const langAttr = (code: string | null): Html =>
  code !== null && /^[A-Za-z0-9-]{1,35}$/.test(code) ? html` lang="${code}"` : html``;

/** Only http(s) links from GLEIF are followed. */
const safeUrl = (url: string): string | null => (/^https?:\/\//i.test(url) ? url : null);

export type Tone = "active" | "lapsed" | "retired";

/** One word for the state of the record, as the prototype shows it. */
export function statusOf(record: LeiRecord): { label: string; tone: Tone } {
  const { entityStatus, registrationStatus } = record;
  if (entityStatus === "INACTIVE") return { label: "inactive", tone: "retired" };
  if (registrationStatus === "LAPSED") return { label: "lapsed", tone: "lapsed" };
  if (["ISSUED", "PENDING_TRANSFER", "PENDING_ARCHIVAL"].includes(registrationStatus)) {
    return { label: "active", tone: "active" };
  }
  if (registrationStatus === "NULL") return { label: "unknown", tone: "lapsed" };
  return { label: words(registrationStatus), tone: "retired" };
}

function addressText(address: Address | null): string | null {
  if (address === null) return null;
  const street = [
    address.mailRouting,
    ...address.lines,
    address.number,
    address.numberWithinBuilding,
  ];
  const place = [address.postalCode, address.city].filter(Boolean).join(" ");
  const parts = [...street, place, address.region ?? address.country].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length === 0 ? null : parts.join(", ");
}

const none = (text = "none reported") => html`<span class="none">${text}</span>`;

function leiLink(lei: string, label: string = lei): Html {
  return html`<a href="${leiPath(lei)}">${label}</a>`;
}

function parentCell(link: ParentLink): Html {
  switch (link.kind) {
    case "reported":
      return leiLink(link.lei);
    case "exception":
      return none(link.reason === null ? "none: no reason given" : `none: ${words(link.reason)}`);
    case "none":
      return none();
  }
}

type Row = [label: string, field: string, value: Html];

function rows(record: LeiRecord): Row[] {
  const status = statusOf(record);
  const legal = addressText(record.legalAddress);
  const hq = addressText(record.headquartersAddress);
  const { expiration, registrationAuthority: authority, legalForm } = record;
  const out: (Row | null)[] = [];
  const add = (label: string, field: string, value: Html | null) => {
    out.push(value === null ? null : [label, field, value]);
  };

  add(
    "status",
    "status",
    html`<span class="st-${status.tone}">${status.label}</span>${
      expiration.date || expiration.reason
        ? html` · ended${expiration.date ? ` ${day(expiration.date)}` : ""}${
            expiration.reason ? ` (${words(expiration.reason)})` : ""
          }`
        : ""
    }`,
  );
  add(
    "registration",
    "registration",
    html`${words(record.registrationStatus)}${
      record.nextRenewalDate ? ` · renews ${day(record.nextRenewalDate)}` : ""
    }`,
  );
  add(
    "also known as",
    "other-names",
    record.otherNames.length === 0
      ? null
      : html`${record.otherNames.map(
          (name) =>
            html`<div${langAttr(name.language)}>${name.name} <span class="none">${words(name.kind)}${
              name.language ? ` · ${name.language}` : ""
            }</span></div>`,
        )}`,
  );
  add("address", "legal-address", legal === null ? null : html`${legal}`);
  add("headquarters", "hq-address", hq === null || hq === legal ? null : html`${hq}`);
  add(
    "register",
    "register",
    record.registerNumber === null && authority.id === null && authority.other === null
      ? null
      : html`${record.registerNumber ?? ""}${
          authority.id || authority.other
            ? html` <span class="none">${authority.id ?? authority.other}</span>`
            : ""
        }`,
  );
  add(
    "legal form",
    "legal-form",
    legalForm.code === null && legalForm.other === null
      ? null
      : html`${legalForm.other ?? legalForm.code}${
          legalForm.other && legalForm.code && legalForm.code !== "8888"
            ? html` <span class="none">${legalForm.code}</span>`
            : ""
        }`,
  );
  add("jurisdiction", "jurisdiction", record.jurisdiction ? html`${record.jurisdiction}` : null);
  add(
    "category",
    "category",
    record.category
      ? html`${words(record.category)}${record.subCategory ? ` · ${words(record.subCategory)}` : ""}`
      : null,
  );
  add("bic", "bic", record.bics.length > 0 ? html`${record.bics.join(" ")}` : null);
  add("parent", "parent", parentCell(record.directParent));
  add(
    "ultimate",
    "ultimate-parent",
    record.ultimateParent.kind === "none" ? null : parentCell(record.ultimateParent),
  );
  add(
    "successor",
    "successors",
    record.successors.length === 0
      ? null
      : html`${record.successors.map((successor) => {
          const label = successor.name ?? successor.lei ?? "";
          return html`<div>${successor.lei === null ? label : leiLink(successor.lei, label)}</div>`;
        })}`,
  );
  add("since", "created", record.creationDate ? html`${day(record.creationDate)}` : null);
  add(
    "registered",
    "registered",
    record.initialRegistrationDate ? html`${day(record.initialRegistrationDate)}` : null,
  );
  add("updated", "updated", record.lastUpdateDate ? html`${day(record.lastUpdateDate)}` : null);
  add(
    "corroboration",
    "corroboration",
    record.corroborationLevel ? html`${words(record.corroborationLevel)}` : null,
  );
  add("managed by", "managing-lou", record.managingLou ? leiLink(record.managingLou) : null);
  return out.filter((row): row is Row => row !== null);
}

// Characters that could end a script element or start a comment inside one.
const JSON_UNSAFE = /[<>&]/g;

/** schema.org Organization, with the LEI as `leiCode`. */
function jsonLd(record: LeiRecord, canonicalUrl: string): string {
  const address = record.legalAddress;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": canonicalUrl,
    name: record.legalName.name,
    legalName: record.legalName.name,
    leiCode: record.lei,
    ...(safeUrl(record.source.webUrl) ? { sameAs: [record.source.webUrl] } : {}),
  };
  const alternates = record.otherNames
    .filter((n) => n.kind !== "transliterated" && n.kind !== "previous")
    .map((n) => n.name);
  if (alternates.length > 0) data.alternateName = alternates;
  if (record.creationDate) data.foundingDate = day(record.creationDate);
  if (record.expiration.date) data.dissolutionDate = day(record.expiration.date);
  if (address) {
    data.address = {
      "@type": "PostalAddress",
      ...(address.lines.length > 0 ? { streetAddress: address.lines.join(", ") } : {}),
      ...(address.city ? { addressLocality: address.city } : {}),
      ...(address.region ? { addressRegion: address.region } : {}),
      ...(address.postalCode ? { postalCode: address.postalCode } : {}),
      ...(address.country ? { addressCountry: address.country } : {}),
    };
  }
  // Keep the data from closing the script element or starting a comment.
  return JSON.stringify(data).replace(
    JSON_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function shell(parts: { title: string; head?: Html; body: Html; copyScript?: boolean }): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${parts.title}</title>
${parts.head ?? ""}
<link rel="stylesheet" href="/styles/record.css">
</head>
<body>
<div class="page">
<header class="top">
<a class="mark" href="/">whichlei</a>
<nav><a href="/">search</a></nav>
</header>
${parts.body}
</div>
${parts.copyScript ? html`<script src="/scripts/copy.js" defer></script>\n` : ""}</body>
</html>
`.value;
}

/** The page for one record: title, description, canonical link, JSON-LD and the fields. */
export function renderRecordPage(record: LeiRecord, context: RecordPageContext): string {
  const name = record.legalName.name;
  const status = statusOf(record);
  const golden = day(record.source.goldenCopyDate);
  const canonicalUrl = `${context.canonicalOrigin}${leiPath(record.lei)}`;
  const place = record.legalAddress?.country ?? record.jurisdiction;
  const description =
    `${name}${place ? ` (${place})` : ""}: LEI ${record.lei}, ${status.label}. ` +
    `Source: GLEIF${golden ? `, golden copy ${golden}` : ""}.`;
  const apiUrl = safeUrl(record.source.apiUrl);
  const webUrl = safeUrl(record.source.webUrl);

  const head = html`<meta name="description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
<script type="application/ld+json">${raw(jsonLd(record, canonicalUrl))}</script>`;

  const body = html`<main class="record">
<div class="inner">
<div>
<h1 class="lei" id="lei">${record.lei}</h1>
<div class="name"${langAttr(record.legalName.language)}>${name}</div>
</div>
<div class="actions">
<button class="btn" type="button" data-copy="${record.lei}" hidden>copy lei</button>
${webUrl ? html`<a class="btn" href="${webUrl}" rel="noopener">gleif.org</a>` : ""}
<span class="copied" role="status" data-copy-status></span>
</div>
<dl class="kv">
${rows(record).map(
  ([label, field, value]) => html`<dt>${label}</dt><dd data-field="${field}">${value}</dd>
`,
)}</dl>
<p class="src">source: ${apiUrl ? html`<a href="${apiUrl}" rel="noopener">GLEIF API</a>` : "GLEIF API"} · golden copy <time data-field="golden-copy">${golden ?? "unknown"}</time> · permalink: ${canonicalUrl}</p>
</div>
</main>`;

  return shell({ title: `${name} · LEI ${record.lei} · whichlei`, head, body, copyScript: true });
}

/** A short page for an answer that has no record: 404, 503 and the like. */
export function renderMessagePage(message: {
  title: string;
  heading: string;
  detail: string;
}): string {
  const body = html`<main class="record">
<div class="inner">
<div>
<h1>${message.heading}</h1>
<div class="name">${message.detail}</div>
</div>
<div class="actions"><a class="btn" href="/">search</a></div>
</div>
</main>`;
  return shell({ title: `${message.title} · whichlei`, body });
}
