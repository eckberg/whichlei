// The record document: what the site knows about one LEI, as one JSON-safe object. It is the
// body of `/lei/<LEI>.json`, the `#record-json` block of the page, the source the HTML and
// Markdown pages are rendered from, and the entry in the Cache API. One GLEIF lookup serves
// all three formats.
//
// It is the `LeiRecord` plus what the site adds: the canonical `url`, names for the codes
// (from the index) and names for the entities it links to (from one more GLEIF call). Field
// order is stable: `lei`, `url`, then the record's own order.

import type { LeiRecord, ParentLink } from "@whichlei/gleif";
import type { Codes } from "./codes.ts";

type Reported = Extract<ParentLink, { kind: "reported" }>;
/** A parent link; a reported parent carries its name when it is known. */
export type DocumentParent = (Reported & { name?: string }) | Exclude<ParentLink, Reported>;

export interface RecordDocument
  extends Omit<
    LeiRecord,
    "registrationAuthority" | "legalForm" | "directParent" | "ultimateParent"
  > {
  /** The canonical HTML page of the record. */
  url: string;
  /** `name` is the register's keeper, from the index codes, when they know the id. */
  registrationAuthority: LeiRecord["registrationAuthority"] & { name?: string };
  /** `name` is the form's name, from the index codes, unless GLEIF gives its own text (`other`). */
  legalForm: LeiRecord["legalForm"] & { name?: string };
  directParent: DocumentParent;
  ultimateParent: DocumentParent;
}

export interface DocumentContext {
  /** Origin of the canonical URL, such as `https://whichlei.com`, without a trailing slash. */
  canonicalOrigin: string;
  /** Names for legal form and registration authority codes. Without them the page shows codes. */
  codes?: Codes | null | undefined;
  /** Legal names by LEI, for the entities the record links to. Without them, the LEIs show. */
  names?: ReadonlyMap<string, string> | null | undefined;
}

/** Only http(s) links from GLEIF are followed. */
export const safeUrl = (url: string): string | null => (/^https?:\/\//i.test(url) ? url : null);

export const documentUrl = (origin: string, lei: string) =>
  `${origin}/lei/${encodeURIComponent(lei)}`;

/** A name from a table of codes. Not inherited ones: the code `constructor` has no name. */
function known(table: Readonly<Record<string, string>> | undefined, code: string | null) {
  if (table === undefined || code === null || !Object.hasOwn(table, code)) return undefined;
  const name = table[code];
  return typeof name === "string" && name !== "" ? name : undefined;
}

export function buildDocument(record: LeiRecord, context: DocumentContext): RecordDocument {
  const { codes, names } = context;
  const { legalForm, registrationAuthority: authority } = record;
  const formName = legalForm.other === null ? known(codes?.elf, legalForm.code) : undefined;
  const keeper = known(codes?.ra, authority.id);
  const parent = (link: ParentLink): DocumentParent => {
    const name = link.kind === "reported" ? names?.get(link.lei) : undefined;
    return link.kind === "reported" && name !== undefined ? { ...link, name } : link;
  };
  const { lei, ...rest } = record;
  return {
    // `lei`, `url`, then the record's own order. A key assigned again below keeps its place.
    lei,
    url: documentUrl(context.canonicalOrigin, lei),
    ...rest,
    registrationAuthority: keeper === undefined ? authority : { ...authority, name: keeper },
    legalForm: formName === undefined ? legalForm : { ...legalForm, name: formName },
    // GLEIF's own name for a successor wins over the one we looked up.
    successors: record.successors.map((successor) => ({
      ...successor,
      name: successor.name ?? (successor.lei === null ? null : (names?.get(successor.lei) ?? null)),
    })),
    directParent: parent(record.directParent),
    ultimateParent: parent(record.ultimateParent),
  };
}

const LEI_SHAPE = /^[0-9A-Z]{20}$/;

/**
 * The LEIs whose names the page would show if it had them: a reported direct or ultimate
 * parent, and successors that have an LEI and no name. Without the record's own LEI, once
 * each, and at most `max` of them. Empty for most records.
 */
export function leisToName(record: LeiRecord, max = 50): string[] {
  const wanted = new Set<string>();
  for (const link of [record.directParent, record.ultimateParent]) {
    if (link.kind === "reported") wanted.add(link.lei);
  }
  for (const successor of record.successors) {
    if (successor.lei !== null && successor.name === null) wanted.add(successor.lei);
  }
  wanted.delete(record.lei);
  return [...wanted].filter((lei) => LEI_SHAPE.test(lei)).slice(0, max);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A document read back from the cache, or null if the text is not one. */
export function parseDocument(text: string): RecordDocument | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) return null;
    const ok =
      typeof value.lei === "string" &&
      typeof value.url === "string" &&
      isObject(value.legalName) &&
      typeof value.legalName.name === "string" &&
      Array.isArray(value.otherNames) &&
      Array.isArray(value.successors) &&
      Array.isArray(value.bics) &&
      isObject(value.legalForm) &&
      isObject(value.registrationAuthority) &&
      isObject(value.directParent) &&
      isObject(value.ultimateParent) &&
      isObject(value.expiration) &&
      isObject(value.source) &&
      typeof value.source.apiUrl === "string";
    return ok ? (value as unknown as RecordDocument) : null;
  } catch {
    return null;
  }
}
