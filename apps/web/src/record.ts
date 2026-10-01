// The record page: one LEI record as a server-rendered HTML document. A pure function of the
// record document, so the search page can reuse it later. Every value goes through `html`,
// which escapes. The styles (fonts included) and the copy script are static assets (see
// scripts/build.ts).

import type { LeiRecord } from "@whichlei/gleif";
import { type Html, html, raw } from "./html.ts";
import {
  buildDocument,
  type DocumentContext,
  documentUrl,
  type RecordDocument,
  safeUrl,
} from "./record-document.ts";
import { day, type Part, recordRows, statusOf } from "./rows.ts";
import type { Tone } from "./status.ts";

export type RecordPageContext = DocumentContext;

const leiPath = (lei: string) => `/lei/${encodeURIComponent(lei)}`;

/** ` lang="sv"`, only when GLEIF's code looks like a language code. */
const langAttr = (code: string | null): Html =>
  code !== null && /^[A-Za-z0-9-]{1,35}$/.test(code) ? html` lang="${code}"` : html``;

export type { Tone };
export { statusOf };

function partHtml(part: Part): Html {
  switch (part.kind) {
    case "text":
    case "punct":
      return html`${part.text}`;
    case "dim":
      return html`<span class="none">${part.text}</span>`;
    case "tone":
      return html`<span class="st-${part.tone}">${part.text}</span>`;
    case "link":
      return html`<a href="${leiPath(part.lei)}">${part.text}</a>`;
  }
}

// Characters that could end a script element or start a comment inside one.
const JSON_UNSAFE = /[<>&]/g;

/** JSON text that cannot close a script element or start a comment inside one. */
const scriptSafe = (json: string): string =>
  json.replace(JSON_UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** schema.org Organization, with the LEI as `leiCode`. */
function jsonLd(record: RecordDocument, canonicalUrl: string, origin: string): string {
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
  const parent = record.directParent;
  if (parent.kind === "reported") {
    data.parentOrganization = {
      "@type": "Organization",
      "@id": documentUrl(origin, parent.lei),
      leiCode: parent.lei,
      ...(parent.name === undefined ? {} : { name: parent.name }),
    };
  }
  // The BICs, and the register number named by its register (`RA000544`).
  const authority = record.registrationAuthority.id;
  const identifiers = [
    ...record.bics.map((bic) => ({ "@type": "PropertyValue", propertyID: "BIC", value: bic })),
    ...(record.registerNumber !== null && authority !== null
      ? [{ "@type": "PropertyValue", propertyID: authority, value: record.registerNumber }]
      : []),
  ];
  if (identifiers.length > 0) data.identifier = identifiers;
  return scriptSafe(JSON.stringify(data));
}

/**
 * Open Graph and Twitter card tags, for link previews. The URL and the image need an origin;
 * without one (no canonical origin is set) they are left out.
 */
export function socialTags(tags: {
  title: string;
  description: string;
  origin: string;
  /** The page's canonical URL, when it has one. */
  url: string | null;
}): Html {
  const { title, description, origin, url } = tags;
  const lines = [
    html`<meta property="og:type" content="website">`,
    html`<meta property="og:site_name" content="whichlei">`,
    html`<meta property="og:title" content="${title}">`,
    html`<meta property="og:description" content="${description}">`,
    ...(url === null ? [] : [html`<meta property="og:url" content="${url}">`]),
    ...(origin === "" ? [] : [html`<meta property="og:image" content="${origin}/icon-512.png">`]),
    html`<meta name="twitter:card" content="summary">`,
  ];
  return raw(lines.map((line) => line.value).join("\n"));
}

/** The page around a body: the head with its icons and styles, the header, optional scripts. */
export function renderPage(parts: {
  title: string;
  head?: Html;
  body: Html;
  scripts?: boolean;
}): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${parts.title}</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
${parts.scripts ? html`<script src="/scripts/copy.js" defer></script>\n<script src="/scripts/stats.js" defer></script>\n` : ""}</body>
</html>
`.value;
}

/** The page for one record document: title, description, links, JSON-LD and the fields. */
export function renderDocumentPage(record: RecordDocument, origin: string): string {
  const name = record.legalName.name;
  const status = statusOf(record);
  const golden = day(record.source.goldenCopyDate);
  const canonicalUrl = documentUrl(origin, record.lei);
  const place = record.legalAddress?.country ?? record.jurisdiction;
  const title = `${name} · LEI ${record.lei} · whichlei`;
  const description =
    `${name}${place ? ` (${place})` : ""}: LEI ${record.lei}, ${status.label}. ` +
    `Source: GLEIF${golden ? `, golden copy ${golden}` : ""}.`;
  const apiUrl = safeUrl(record.source.apiUrl);
  const webUrl = safeUrl(record.source.webUrl);

  const head = html`<meta name="description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
${socialTags({ title, description, origin, url: canonicalUrl })}
<script type="application/ld+json">${raw(jsonLd(record, canonicalUrl, origin))}</script>`;

  const body = html`<main class="record">
<div class="inner">
<h1 class="title"><span class="lei" id="lei">${record.lei}</span>
<span class="name"${langAttr(record.legalName.language)}>${name}</span></h1>
<div class="actions">
<button class="btn" type="button" data-copy="${record.lei}" hidden>copy lei</button>
<button class="btn" type="button" data-copy-json="record-json" hidden>copy json</button>
${webUrl ? html`<a class="btn" href="${webUrl}" rel="noopener">gleif.org</a>` : ""}
<span class="copied" role="status" data-copy-status></span>
</div>
<dl class="kv">
${recordRows(record).map(
  (row) => html`<dt>${row.label}</dt><dd data-field="${row.field}">${
    "items" in row
      ? row.items.map((item) => html`<div${langAttr(item.lang)}>${item.parts.map(partHtml)}</div>`)
      : row.parts.map(partHtml)
  }</dd>
`,
)}</dl>
<script type="application/json" id="record-json">${raw(scriptSafe(JSON.stringify(record)))}</script>
<p class="src">source: ${apiUrl ? html`<a href="${apiUrl}" rel="noopener">GLEIF API</a>` : "GLEIF API"} · golden copy <time data-field="golden-copy">${golden ?? "unknown"}</time> · permalink: ${canonicalUrl}</p>
</div>
</main>`;

  return renderPage({ title, head, body, scripts: true });
}

/**
 * The page for a record as GLEIF gave it, with names for its codes and linked entities when
 * the context has them. For tests and the bench; the Worker builds the document once and
 * renders from that.
 */
export function renderRecordPage(record: LeiRecord, context: RecordPageContext): string {
  return renderDocumentPage(buildDocument(record, context), context.canonicalOrigin);
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
  return renderPage({ title: `${message.title} · whichlei`, body });
}
