// Turn GLEIF's JSON:API documents into the flat shapes in types.ts. Nothing here touches the
// network. GLEIF sends null for most things that are missing; we keep null, never "".

import { GleifError } from "./errors.ts";
import type {
  Address,
  LeiRecord,
  LeiSummary,
  LocalisedName,
  OtherName,
  OtherNameKind,
  Page,
  ParentLink,
  Successor,
} from "./types.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const obj = (value: unknown): Json => (isObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function unexpected(what: string): GleifError {
  return new GleifError("failed", `Unexpected response from GLEIF: ${what}`);
}

/** The `data` member of a document, as a list (lookups) or a single resource (one record). */
function resources(document: unknown): Json[] {
  const data = obj(document).data;
  return (Array.isArray(data) ? data : [data]).filter(isObject);
}

const goldenCopyDate = (document: unknown): string | null =>
  str(obj(obj(obj(document).meta).goldenCopy).publishDate);

const NAME_KINDS: Record<string, OtherNameKind> = {
  TRADING_OR_OPERATING_NAME: "trading",
  ALTERNATIVE_LANGUAGE_LEGAL_NAME: "alternative-language",
  PREVIOUS_LEGAL_NAME: "previous",
};

function otherNames(entity: Json): OtherName[] {
  const names: OtherName[] = [];
  for (const [key, transliterated] of [
    ["otherNames", false],
    ["transliteratedOtherNames", true],
  ] as const) {
    for (const item of list(entity[key]).filter(isObject)) {
      const name = str(item.name);
      if (name === null) continue;
      const type = str(item.type) ?? "";
      names.push({
        name,
        language: str(item.language),
        kind: transliterated ? "transliterated" : (NAME_KINDS[type] ?? "other"),
        type,
      });
    }
  }
  return names;
}

function address(value: unknown): Address | null {
  if (!isObject(value)) return null;
  return {
    language: str(value.language),
    lines: list(value.addressLines).filter((line) => typeof line === "string"),
    number: str(value.addressNumber),
    numberWithinBuilding: str(value.addressNumberWithinBuilding),
    mailRouting: str(value.mailRouting),
    city: str(value.city),
    region: str(value.region),
    country: str(value.country),
    postalCode: str(value.postalCode),
  };
}

function successors(entity: Json): Successor[] {
  const many = list(entity.successorEntities)
    .filter(isObject)
    .map((item) => ({ lei: str(item.lei), name: str(item.name) }));
  if (many.length > 0) return many;
  // The older single field repeats the list when both are set.
  const one = obj(entity.successorEntity);
  return str(one.lei) || str(one.name) ? [{ lei: str(one.lei), name: str(one.name) }] : [];
}

/**
 * A parent link from a relationship member. With `include=direct-parent,ultimate-parent`,
 * `data` names either the parent's LEI or a reporting exception. The exception's details come
 * along in `included`; the parent's record does not (only its id), so its name is not here.
 * Without either, GLEIF says nothing about a parent.
 */
function parentLink(relationship: unknown, included: Map<string, Json>): ParentLink {
  const ref = obj(obj(relationship).data);
  const type = str(ref.type);
  const id = str(ref.id);
  if (type === null || id === null) return { kind: "none" };
  if (type === "lei-records") return { kind: "reported", lei: id };
  if (type === "reporting-exceptions") {
    const attributes = obj(included.get(`${type}:${id}`)?.attributes);
    return {
      kind: "exception",
      reason: str(attributes.reason),
      reference: str(attributes.reference),
    };
  }
  return { kind: "none" };
}

/** A record fetched with `include=direct-parent,ultimate-parent`. */
export function parseRecord(document: unknown, baseUrl: string): LeiRecord {
  const [resource] = resources(document);
  const attributes = obj(resource?.attributes);
  const entity = obj(attributes.entity);
  const registration = obj(attributes.registration);
  const lei = str(attributes.lei) ?? str(resource?.id);
  const legalName = parseLegalName(entity.legalName);
  if (lei === null || legalName === null) throw unexpected("no LEI or legal name in the record");

  const included = new Map<string, Json>();
  for (const item of list(obj(document).included).filter(isObject)) {
    included.set(`${str(item.type)}:${str(item.id)}`, item);
  }
  const relationships = obj(resource?.relationships);
  const registeredAt = obj(entity.registeredAt);
  const legalForm = obj(entity.legalForm);
  const expiration = obj(entity.expiration);

  return {
    lei,
    legalName,
    otherNames: otherNames(entity),
    entityStatus: str(entity.status) ?? "NULL",
    registrationStatus: str(registration.status) ?? "NULL",
    legalAddress: address(entity.legalAddress),
    headquartersAddress: address(entity.headquartersAddress),
    registrationAuthority: { id: str(registeredAt.id), other: str(registeredAt.other) },
    registerNumber: str(entity.registeredAs),
    legalForm: { code: str(legalForm.id), other: str(legalForm.other) },
    jurisdiction: str(entity.jurisdiction),
    category: str(entity.category),
    subCategory: str(entity.subCategory),
    creationDate: str(entity.creationDate),
    initialRegistrationDate: str(registration.initialRegistrationDate),
    lastUpdateDate: str(registration.lastUpdateDate),
    nextRenewalDate: str(registration.nextRenewalDate),
    corroborationLevel: str(registration.corroborationLevel),
    managingLou: str(registration.managingLou),
    expiration: { date: str(expiration.date), reason: str(expiration.reason) },
    successors: successors(entity),
    bics: list(attributes.bic).filter((bic) => typeof bic === "string"),
    directParent: parentLink(relationships["direct-parent"], included),
    ultimateParent: parentLink(relationships["ultimate-parent"], included),
    source: {
      apiUrl: str(obj(resource?.links).self) ?? `${baseUrl}/lei-records/${lei}`,
      webUrl: `https://search.gleif.org/#/record/${lei}`,
      goldenCopyDate: goldenCopyDate(document),
    },
  };
}

function parseLegalName(value: unknown): LocalisedName | null {
  const name = str(obj(value).name);
  return name === null ? null : { name, language: str(obj(value).language) };
}

function parseSummary(resource: Json): LeiSummary | null {
  const attributes = obj(resource.attributes);
  const entity = obj(attributes.entity);
  const lei = str(attributes.lei) ?? str(resource.id);
  const legalName = str(obj(entity.legalName).name);
  if (lei === null || legalName === null) return null;
  return {
    lei,
    legalName,
    country: str(obj(entity.legalAddress).country),
    jurisdiction: str(entity.jurisdiction),
    registrationAuthorityId: str(obj(entity.registeredAt).id),
    registerNumber: str(entity.registeredAs),
    entityStatus: str(entity.status) ?? "NULL",
    registrationStatus: str(obj(attributes.registration).status) ?? "NULL",
  };
}

function parsePage<T>(
  document: unknown,
  items: T[],
  requested: { page: number; pageSize: number },
): Page<T> {
  const pagination = obj(obj(obj(document).meta).pagination);
  return {
    items,
    total: num(pagination.total, items.length),
    page: num(pagination.currentPage, requested.page),
    pageSize: num(pagination.perPage, requested.pageSize),
    pageCount: num(pagination.lastPage, 1),
    goldenCopyDate: goldenCopyDate(document),
  };
}

/** A list of LEI records, reduced to summaries. */
export function parseSummaries(
  document: unknown,
  requested: { page: number; pageSize: number },
): Page<LeiSummary> {
  if (!Array.isArray(obj(document).data)) throw unexpected("no data list");
  const items = resources(document).flatMap((resource) => parseSummary(resource) ?? []);
  return parsePage(document, items, requested);
}

/** A page of the `isins` relationship. */
export function parseIsins(
  document: unknown,
  requested: { page: number; pageSize: number },
): Page<string> {
  if (!Array.isArray(obj(document).data)) throw unexpected("no data list");
  const items = resources(document).flatMap((resource) => str(obj(resource.attributes).isin) ?? []);
  return parsePage(document, items, requested);
}
