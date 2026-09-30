// The shapes the client returns. They are flat and JSON-safe, so a Worker can render them and
// a page can serialise them. Dates stay ISO 8601 strings exactly as GLEIF sends them. Codes
// (statuses, categories, reasons) stay GLEIF's own strings: the list of values is GLEIF's to
// extend.

export interface GleifOptions {
  /** Defaults to the global `fetch`. Inject one in tests, or to add caching in a Worker. */
  fetch?: Fetch | undefined;
  signal?: AbortSignal | undefined;
  /** Defaults to GLEIF's production API, `https://api.gleif.org/api/v1`. */
  baseUrl?: string | undefined;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface PageOptions {
  /** 1-based. Defaults to 1. */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface Page<T> {
  items: T[];
  /** Hits across all pages. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** When GLEIF published the golden copy these answers come from, ISO 8601. */
  goldenCopyDate: string | null;
}

export interface LocalisedName {
  name: string;
  /** BCP 47-ish code as GLEIF records it ("sv", "en-US"). */
  language: string | null;
}

export type OtherNameKind =
  | "trading"
  | "alternative-language"
  | "previous"
  | "transliterated"
  | "other";

export interface OtherName extends LocalisedName {
  kind: OtherNameKind;
  /** GLEIF's own type, such as `TRADING_OR_OPERATING_NAME` or `PREVIOUS_LEGAL_NAME`. */
  type: string;
}

export interface Address {
  language: string | null;
  lines: string[];
  number: string | null;
  numberWithinBuilding: string | null;
  mailRouting: string | null;
  city: string | null;
  /** ISO 3166-2, such as `SE-AB`. */
  region: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  postalCode: string | null;
}

/**
 * A parent link. GLEIF reports either a parent LEI or the reason there is none. The parent's
 * name is not in the answer: look it up with `fetchRecord` or in the index.
 */
export type ParentLink =
  | { kind: "reported"; lei: string }
  /** The entity declared why it does not report a parent, e.g. `NO_KNOWN_PERSON`. */
  | { kind: "exception"; reason: string | null; reference: string | null }
  /** GLEIF has neither a parent nor an exception for this record (branches, for one). */
  | { kind: "none" };

export interface Successor {
  lei: string | null;
  name: string | null;
}

export interface LeiRecord {
  lei: string;
  legalName: LocalisedName;
  /** Trading, alternative-language and previous names, then transliterated ones. */
  otherNames: OtherName[];

  /** `ACTIVE`, `INACTIVE` or `NULL`. */
  entityStatus: string;
  /** `ISSUED`, `LAPSED`, `RETIRED`, `ANNULLED`, `DUPLICATE`, `MERGED` and others. */
  registrationStatus: string;

  legalAddress: Address | null;
  headquartersAddress: Address | null;

  /** The business register the entity is listed in, such as `RA000544`. */
  registrationAuthority: { id: string | null; other: string | null };
  /** The entity's number in that register (`registeredAs`). */
  registerNumber: string | null;
  /** ISO 20275 Entity Legal Form code. `8888` means "other": see `other`. */
  legalForm: { code: string | null; other: string | null };
  /** ISO 3166-1 or -2 code, such as `SE` or `CA-ON`. */
  jurisdiction: string | null;
  /** `GENERAL`, `FUND`, `BRANCH`, `SOLE_PROPRIETOR`, `RESIGNED`... */
  category: string | null;
  subCategory: string | null;

  /** Entity creation date (incorporation), when GLEIF has it. */
  creationDate: string | null;
  initialRegistrationDate: string | null;
  lastUpdateDate: string | null;
  nextRenewalDate: string | null;
  /** How well GLEIF's managing LOU checked the record, e.g. `FULLY_CORROBORATED`. */
  corroborationLevel: string | null;
  /** LEI of the managing LOU. */
  managingLou: string | null;

  /** When the entity ended, and why, e.g. `DISSOLVED`. */
  expiration: { date: string | null; reason: string | null };
  successors: Successor[];

  /** 8- and 11-character BICs, as GLEIF stores them (always 11 characters in practice). */
  bics: string[];
  directParent: ParentLink;
  ultimateParent: ParentLink;

  /** Where this record came from and how fresh it is (DESIGN.md decision 10). */
  source: {
    /** The record on the GLEIF API. */
    apiUrl: string;
    /** The record on GLEIF's search site, for a person to read. */
    webUrl: string;
    /** When GLEIF published the golden copy the API served this from. */
    goldenCopyDate: string | null;
  };
}

/** What a lookup shows per hit: enough to pick the right entity. */
export interface LeiSummary {
  lei: string;
  legalName: string;
  /** Country of the legal address. */
  country: string | null;
  jurisdiction: string | null;
  registrationAuthorityId: string | null;
  registerNumber: string | null;
  entityStatus: string;
  registrationStatus: string;
}
