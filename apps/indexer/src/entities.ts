// The level 1 golden copy, one pass: for every LEI its names, status, prominence and index
// terms. Port of research/ranking/signals/build_entities.py and the entity part of
// prep.py, which wrote and re-read a 600 MB TSV; here each row is used as it arrives.
import { indexTerms, nameTokens, type Status } from "@whichlei/core";
import { columnsOf, parseCsvStream } from "./csv.ts";
import { PostingsBuilder } from "./postings.ts";
import {
  codePointLength,
  type ProminenceInput,
  prominence,
  registrationYear,
} from "./prominence.ts";
import type { Relationships } from "./signals.ts";
import { unzipStream } from "./unzip.ts";

/** What the index keeps of every entity, by entity number: the row order of the golden copy. */
export interface Entities {
  count: number;
  lei: string[];
  /** Legal name, as GLEIF has it, tabs and line breaks replaced. */
  name: string[];
  /** Trading, alternative-language and transliterated names that differ from the legal name. */
  otherNames: (readonly string[] | undefined)[];
  country: string[];
  status: Status[];
  /** Prominence at full precision: a float32, as in the research. */
  prominence: Float32Array;
  /** Year of initial registration as a fraction, NaN if unknown (float32, as in the research). */
  registeredYear: Float32Array;
}

export interface EntityStats {
  /** Rows of the golden copy. */
  rows: number;
  /** Rows without an LEI, skipped. */
  noLei: number;
  /** Entities with a registration status GLEIF has not documented, read as MERGED. */
  unknownStatus: number;
  /** Names that hold " | ", which the research's intermediate TSV would have split in two. */
  pipeNames: number;
  /** Entities that index no term, so no search can find them. */
  noTerms: number;
}

export interface EntityInputs {
  relationships: Relationships;
  isins: ReadonlyMap<string, number>;
  bics: ReadonlySet<string>;
  /** The golden copy's date as a year fraction, for registration age. */
  nowYear: number;
}

// Python's str.strip() removes Unicode whitespace; JavaScript's trim() removes a slightly
// different set. The names have to come out the same.
const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** A name as the research cleaned it: separators become spaces, the ends are stripped. */
export function cleanName(name: string): string {
  return name.replace(/[\t\r\n]/g, " ").replace(STRIP, "");
}

/** Registration status letters, in the research's order. A status not listed reads as MERGED. */
const STATUS = {
  ISSUED: "I",
  LAPSED: "L",
  PENDING_TRANSFER: "T",
  PENDING_ARCHIVAL: "P",
  RETIRED: "R",
  DUPLICATE: "D",
  ANNULLED: "A",
  MERGED: "M",
} as const satisfies Record<string, string>;

/** Name types, as prep.py ranks them: lower is better; 4 (previous names) is not indexed. */
function nameType(type: string): number {
  switch (type) {
    case "TRADING_OR_OPERATING_NAME":
      return 1;
    case "ALTERNATIVE_LANGUAGE_LEGAL_NAME":
      return 2;
    case "TRANSLITERATED":
      return 3;
    default:
      return 4;
  }
}

const COLUMNS = [
  "LEI",
  "Entity.LegalName",
  "Entity.LegalAddress.Country",
  "Entity.EntityStatus",
  "Entity.EntityCategory",
  "Registration.RegistrationStatus",
  "Registration.InitialRegistrationDate",
] as const;
const OTHER_NAMES = [1, 2, 3, 4, 5].map((i) => `Entity.OtherEntityNames.OtherEntityName.${i}`);
const TRANSLITERATED = [1, 2, 3, 4, 5].map(
  (i) => `Entity.TransliteratedOtherEntityNames.TransliteratedOtherEntityName.${i}`,
);

/**
 * Read the golden copy. Returns the entities and their postings. `onProgress` is called
 * every 500,000 rows.
 */
export async function readEntities(
  zipPath: string,
  inputs: EntityInputs,
  onProgress?: (rows: number) => void,
): Promise<{ entities: Entities; postings: PostingsBuilder; stats: EntityStats }> {
  const { relationships, isins, bics, nowYear } = inputs;
  const postings = new PostingsBuilder();
  const entities: Entities = {
    count: 0,
    lei: [],
    name: [],
    otherNames: [],
    country: [],
    status: [],
    prominence: new Float32Array(1 << 22),
    registeredYear: new Float32Array(1 << 22),
  };
  const stats: EntityStats = {
    rows: 0,
    noLei: 0,
    unknownStatus: 0,
    pipeNames: 0,
    noTerms: 0,
  };
  let k = {} as Record<(typeof COLUMNS)[number], number>;
  let otherName: number[] = [];
  let otherType: number[] = [];
  let transliterated: number[] = [];
  const input: ProminenceInput = {
    entityStatus: "",
    registrationStatus: "",
    category: "",
    nDirect: 0,
    nUltimate: 0,
    nBranch: 0,
    hasParent: false,
    isin: 0,
    bic: false,
    registeredYear: 0,
    nameLength: 0,
  };
  const terms = new Set<string>();

  function add(row: string[]): void {
    stats.rows++;
    if (stats.rows % 500_000 === 0) onProgress?.(stats.rows);
    const lei = row[k.LEI] as string;
    if (lei === "") {
      stats.noLei++;
      return;
    }

    const name = cleanName(row[k["Entity.LegalName"]] as string);
    // Variants: the legal name, then the other names by type, then the transliterated ones.
    const variants: [type: number, name: string][] = [];
    const listed: string[] = [];
    for (let i = 0; i < OTHER_NAMES.length; i++) {
      const raw = row[otherName[i] as number] as string;
      if (raw === "") continue;
      const other = cleanName(raw);
      const type = nameType(cleanName(row[otherType[i] as number] as string));
      variants.push([type, other]);
      // Only trading and alternative-language names are listed with the entity.
      if ((type === 1 || type === 2) && other !== "") listed.push(other);
    }
    for (const column of transliterated) {
      const raw = row[column] as string;
      if (raw === "") continue;
      const other = cleanName(raw);
      variants.push([3, other]);
      if (other !== "") listed.push(other);
    }
    // Type order, each type in the order of the file. Array.prototype.sort is stable.
    variants.sort((a, b) => a[0] - b[0]);
    for (const [, n] of variants) if (n.includes(" | ")) stats.pipeNames++;
    if (name.includes(" | ")) stats.pipeNames++;

    // Index terms: the legal name and the names of types 1 to 3, skipping a name whose
    // tokens an earlier one already had. Previous names are matched by nobody.
    terms.clear();
    const seen = new Set<string>();
    const legal = nameTokens(name);
    seen.add(legal.seq.join(" "));
    for (const t of indexTerms(legal)) terms.add(t);
    for (const [type, n] of variants) {
      if (type === 4) break;
      const t = nameTokens(n);
      const key = t.seq.join(" ");
      if (t.seq.length === 0 || seen.has(key)) continue;
      seen.add(key);
      for (const term of indexTerms(t)) terms.add(term);
    }

    const other = [...new Set(listed)].filter((n) => n !== name);

    const id = entities.count++;
    if (id === entities.prominence.length) {
      const grow = (old: Float32Array) => {
        const bigger = new Float32Array(old.length * 2);
        bigger.set(old);
        return bigger;
      };
      entities.prominence = grow(entities.prominence);
      entities.registeredYear = grow(entities.registeredYear);
    }

    let registration = row[k["Registration.RegistrationStatus"]] as string;
    if (!(registration in STATUS)) {
      stats.unknownStatus++;
      registration = "MERGED";
    }
    const entityStatus = row[k["Entity.EntityStatus"]] as string;
    const letter = STATUS[registration as keyof typeof STATUS];
    const counts = relationships.parents.get(lei);
    input.entityStatus = entityStatus;
    input.registrationStatus = registration;
    input.category = row[k["Entity.EntityCategory"]] as string;
    input.nDirect = counts?.direct ?? 0;
    input.nUltimate = counts?.ultimate ?? 0;
    input.nBranch = counts?.branch ?? 0;
    input.hasParent = relationships.hasParent.has(lei);
    input.isin = isins.get(lei) ?? 0;
    input.bic = bics.has(lei);
    input.registeredYear = Math.fround(
      registrationYear(row[k["Registration.InitialRegistrationDate"]] as string),
    );
    input.nameLength = codePointLength(name);

    entities.lei.push(lei);
    entities.name.push(name);
    entities.otherNames.push(other.length > 0 ? other : undefined);
    entities.country.push(cleanName(row[k["Entity.LegalAddress.Country"]] as string));
    // Lower case marks an INACTIVE entity. An entity with no status is not marked.
    entities.status.push((entityStatus === "INACTIVE" ? letter.toLowerCase() : letter) as Status);
    entities.registeredYear[id] = input.registeredYear;
    entities.prominence[id] = prominence(input, nowYear);

    if (terms.size === 0) stats.noTerms++;
    postings.add(id, terms);
  }

  await parseCsvStream(unzipStream(zipPath), add, {
    onHeader: (header) => {
      k = columnsOf(header, COLUMNS);
      const other = OTHER_NAMES.map((base) => columnsOf(header, [base, `${base}.type`]));
      otherName = other.map((c, i) => c[OTHER_NAMES[i] as string] as number);
      otherType = other.map((c, i) => c[`${OTHER_NAMES[i]}.type`] as number);
      transliterated = TRANSLITERATED.map((name) => columnsOf(header, [name])[name] as number);
      return [...Object.values(k), ...otherName, ...otherType, ...transliterated];
    },
  });
  return { entities, postings, stats };
}
