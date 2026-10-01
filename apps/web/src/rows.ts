// The rows of a record page, as data: a label, the field's name and a value made of parts. The
// HTML page and the Markdown page each draw them in their own way, so the two show the same
// rows. Parts carry no markup and no escaping; the renderers do that.

import type { Address, LeiRecord } from "@whichlei/gleif";
import type { DocumentParent, RecordDocument } from "./record-document.ts";
import { stateOf, type Tone, words } from "./status.ts";

export type Part =
  | { kind: "text"; text: string }
  /** The site's own punctuation around GLEIF's text: never escaped. */
  | { kind: "punct"; text: string }
  /** Secondary text: a code beside a name, or "none reported". */
  | { kind: "dim"; text: string }
  /** The state of the record, with its colour. */
  | { kind: "tone"; text: string; tone: Tone }
  /** A link to the page of an LEI. */
  | { kind: "link"; text: string; lei: string };

export interface Item {
  parts: Part[];
  /** Language of the text, when GLEIF gives one. */
  lang: string | null;
}

/** One value, or a list of them (other names, successors). */
export type Row = { label: string; field: string } & ({ parts: Part[] } | { items: Item[] });

const text = (value: string): Part => ({ kind: "text", text: value });
const punct = (value: string): Part => ({ kind: "punct", text: value });
const dim = (value: string): Part => ({ kind: "dim", text: value });
const link = (lei: string, label: string = lei): Part => ({ kind: "link", text: label, lei });
const SPACE = text(" ");

/** The date part of an ISO 8601 timestamp, `2026-09-30`. */
export const day = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

/** One word for the state of the record, as the prototype shows it. */
export function statusOf(record: Pick<LeiRecord, "entityStatus" | "registrationStatus">): {
  label: string;
  tone: Tone;
} {
  return stateOf(record.entityStatus, record.registrationStatus);
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

/** A parent: its name (when known) as the link, with the LEI beside it; else the LEI. */
function parentParts(parent: DocumentParent): Part[] {
  switch (parent.kind) {
    case "reported":
      return parent.name === undefined
        ? [link(parent.lei)]
        : [link(parent.lei, parent.name), SPACE, dim(parent.lei)];
    case "exception":
      return [
        dim(parent.reason === null ? "none: no reason given" : `none: ${words(parent.reason)}`),
      ];
    case "none":
      return [dim("none reported")];
  }
}

/** "Bolagsverket · RA000544", or the code alone when the register has no name here. */
function registerKeeper(authority: RecordDocument["registrationAuthority"]): string {
  if (authority.id === null) return authority.other ?? "";
  return authority.name ? `${authority.name} · ${authority.id}` : authority.id;
}

export function recordRows(record: RecordDocument): Row[] {
  const status = statusOf(record);
  const legal = addressText(record.legalAddress);
  const hq = addressText(record.headquartersAddress);
  const { expiration, registrationAuthority: authority, legalForm } = record;
  const out: Row[] = [];
  const add = (label: string, field: string, parts: Part[] | null) => {
    if (parts !== null) out.push({ label, field, parts });
  };
  const addText = (label: string, field: string, value: string | null) =>
    add(label, field, value === null || value === "" ? null : [text(value)]);

  add("status", "status", [
    { kind: "tone", text: status.label, tone: status.tone },
    ...(expiration.date || expiration.reason
      ? [text(` · ended${expiration.date ? ` ${day(expiration.date)}` : ""}`)]
      : []),
    ...(expiration.reason ? [punct(" ("), text(words(expiration.reason)), punct(")")] : []),
  ]);
  addText(
    "registration",
    "registration",
    `${words(record.registrationStatus)}${
      record.nextRenewalDate ? ` · renews ${day(record.nextRenewalDate)}` : ""
    }`,
  );
  if (record.otherNames.length > 0) {
    out.push({
      label: "also known as",
      field: "other-names",
      items: record.otherNames.map((name) => ({
        parts: [
          text(name.name),
          SPACE,
          dim(`${words(name.kind)}${name.language ? ` · ${name.language}` : ""}`),
        ],
        lang: name.language,
      })),
    });
  }
  addText("address", "legal-address", legal);
  addText("headquarters", "hq-address", hq === legal ? null : hq);

  if (record.registerNumber !== null || authority.id !== null || authority.other !== null) {
    const keeper = authority.id || authority.other ? [dim(registerKeeper(authority))] : [];
    add(
      "register",
      "register",
      record.registerNumber === null
        ? keeper
        : [text(record.registerNumber), ...(keeper.length > 0 ? [SPACE, ...keeper] : [])],
    );
  }

  if (legalForm.code !== null || legalForm.other !== null) {
    const name = legalForm.other ?? legalForm.name ?? legalForm.code ?? "";
    add("legal form", "legal-form", [
      text(name),
      ...(legalForm.code && legalForm.code !== "8888" && name !== legalForm.code
        ? [SPACE, dim(legalForm.code)]
        : []),
    ]);
  }
  addText("jurisdiction", "jurisdiction", record.jurisdiction);
  addText(
    "category",
    "category",
    record.category
      ? `${words(record.category)}${record.subCategory ? ` · ${words(record.subCategory)}` : ""}`
      : null,
  );
  addText("bic", "bic", record.bics.length > 0 ? record.bics.join(" ") : null);
  add("parent", "parent", parentParts(record.directParent));
  add(
    "ultimate",
    "ultimate-parent",
    record.ultimateParent.kind === "none" ? null : parentParts(record.ultimateParent),
  );
  if (record.successors.length > 0) {
    out.push({
      label: "successor",
      field: "successors",
      items: record.successors.map((successor) => {
        const { lei, name } = successor;
        const parts =
          lei === null
            ? [text(name ?? "")]
            : name === null
              ? [link(lei)]
              : [link(lei, name), SPACE, dim(lei)];
        return { parts, lang: null };
      }),
    });
  }
  addText("since", "created", day(record.creationDate));
  addText("registered", "registered", day(record.initialRegistrationDate));
  addText("updated", "updated", day(record.lastUpdateDate));
  addText(
    "corroboration",
    "corroboration",
    record.corroborationLevel ? words(record.corroborationLevel) : null,
  );
  add("managed by", "managing-lou", record.managingLou ? [link(record.managingLou)] : null);
  return out;
}
