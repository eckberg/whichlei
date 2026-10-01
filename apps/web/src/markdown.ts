// The record as Markdown, for people and programs that read text (`/lei/<LEI>.md`, or
// `Accept: text/markdown`). The same rows as the HTML page, as a list. Every string from GLEIF
// is untrusted, so each goes through `escapeMarkdown`: a name must not become a link, a heading,
// a list or HTML in whatever renders this.

import { documentUrl, type RecordDocument, safeUrl } from "./record-document.ts";
import { day, type Part, recordRows } from "./rows.ts";

const LINE_BREAKS = /[\r\n\v\f\u0085\u2028\u2029]+/g;
// Characters that mean something in Markdown. `@` and the colon of `://` and the dot of `www.`
// would let a renderer turn a bare address in a name into a link.
const SPECIAL = /[\\*_[\]()#<>`|@]|:(?=\/\/)|(?<=\bwww)\./gi;

/**
 * Text that a Markdown renderer shows as it is. One line: a line break in a name must not start
 * a new block. A leading `-`, `+` or `1.` (a list marker) is escaped too.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(LINE_BREAKS, " ")
    .replace(SPECIAL, (char) => `\\${char}`)
    .replace(/^(\s*)([-+])(?=\s|$)/, "$1\\$2")
    .replace(/^(\s*\d+)\.(?=\s|$)/, "$1\\.");
}

/**
 * A link destination that cannot end the link or start another one: everything but URL
 * characters is percent-encoded, brackets and parentheses included.
 */
export function markdownUrl(url: string): string {
  const encoder = new TextEncoder();
  return url.replace(/[^A-Za-z0-9\-._~:/?#@$&+,;=%]/gu, (char) =>
    [...encoder.encode(char)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

function partMarkdown(part: Part, index: number, origin: string): string {
  if (part.kind === "punct") return part.text;
  const shown = escapeMarkdown(part.text);
  switch (part.kind) {
    case "text":
    case "tone":
      return shown;
    // Secondary text reads as a remark when it follows something: `Aktiebolag (XJHM)`.
    case "dim":
      return index === 0 ? shown : `(${shown})`;
    case "link":
      return `[${shown}](${markdownUrl(documentUrl(origin, part.lei))})`;
  }
}

const partsMarkdown = (parts: Part[], origin: string) =>
  parts.map((part, index) => partMarkdown(part, index, origin)).join("");

/** The record as a Markdown page, with absolute links. */
export function renderMarkdown(record: RecordDocument, origin: string): string {
  const lines = [
    `# ${escapeMarkdown(record.legalName.name)}`,
    "",
    `LEI: ${escapeMarkdown(record.lei)}`,
    "",
  ];
  for (const row of recordRows(record)) {
    // One value goes on the row's line; several, as a list under it.
    const values = "parts" in row ? [row.parts] : row.items.map((item) => item.parts);
    if (values.length === 1) {
      lines.push(`- **${row.label}:** ${partsMarkdown(values[0] ?? [], origin)}`);
    } else {
      lines.push(`- **${row.label}:**`);
      for (const parts of values) lines.push(`  - ${partsMarkdown(parts, origin)}`);
    }
  }
  const api = safeUrl(record.source.apiUrl);
  const golden = day(record.source.goldenCopyDate);
  lines.push(
    "",
    `Source: ${api ? `[GLEIF API](${markdownUrl(api)})` : "GLEIF API"} · golden copy ${
      golden === null ? "unknown" : escapeMarkdown(golden)
    } · permalink: <${markdownUrl(documentUrl(origin, record.lei))}>`,
    "",
  );
  return lines.join("\n");
}

/** An answer that is not a record, such as a 404. `heading` and `detail` are the site's own text. */
export const renderMarkdownMessage = (heading: string, detail: string): string =>
  `# ${heading}\n\n${detail}\n`;
