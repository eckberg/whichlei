// A tiny golden copy for tests: the same files GLEIF publishes, with the columns the indexer
// reads and a few it does not, written to a directory. Nothing here touches the network.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import type { Inputs } from "./sources.ts";

/** A zip archive with one member, as `unzip -p` reads it. */
export function zipOf(member: string, content: string | Buffer): Buffer {
  const data = Buffer.from(content);
  const packed = deflateRawSync(data);
  const name = Buffer.from(member);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}

/** One CSV record, quoted where RFC 4180 says it has to be. */
export function csvLine(fields: readonly string[]): string {
  return `${fields.map((f) => (/[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(",")}\r\n`;
}

export interface Spec {
  lei: string;
  name: string;
  country?: string;
  entityStatus?: string;
  category?: string;
  registration?: string;
  /** ISO date-time of the initial registration. */
  registered?: string;
  /** Other entity names and their types. */
  others?: [name: string, type: string][];
  transliterated?: string[];
}

const OTHER = [1, 2, 3, 4, 5].map((i) => `Entity.OtherEntityNames.OtherEntityName.${i}`);
const TRANSLITERATED = [1, 2, 3, 4, 5].map(
  (i) => `Entity.TransliteratedOtherEntityNames.TransliteratedOtherEntityName.${i}`,
);
// Columns the indexer does not read are here too, between the ones it does.
const LEI2_HEADER = [
  "LEI",
  "Entity.LegalName",
  "Entity.LegalName.xmllang",
  ...OTHER.flatMap((c) => [c, `${c}.type`]),
  ...TRANSLITERATED,
  "Entity.LegalAddress.City",
  "Entity.LegalAddress.Country",
  "Entity.EntityCategory",
  "Entity.EntityStatus",
  "Registration.InitialRegistrationDate",
  "Registration.RegistrationStatus",
  "Registration.ValidationSources",
];

export function lei2Csv(specs: readonly Spec[]): string {
  let out = csvLine(LEI2_HEADER);
  for (const s of specs) {
    const row = new Map<string, string>([
      ["LEI", s.lei],
      ["Entity.LegalName", s.name],
      ["Entity.LegalName.xmllang", "en"],
      ["Entity.LegalAddress.City", "Somewhere, Else"],
      ["Entity.LegalAddress.Country", s.country ?? "SE"],
      ["Entity.EntityCategory", s.category ?? "GENERAL"],
      ["Entity.EntityStatus", s.entityStatus ?? "ACTIVE"],
      ["Registration.InitialRegistrationDate", s.registered ?? "2015-03-04T00:00:00.000Z"],
      ["Registration.RegistrationStatus", s.registration ?? "ISSUED"],
      ["Registration.ValidationSources", "FULLY_CORROBORATED"],
    ]);
    (s.others ?? []).forEach(([name, type], i) => {
      row.set(OTHER[i] as string, name);
      row.set(`${OTHER[i]}.type`, type);
    });
    (s.transliterated ?? []).forEach((name, i) => {
      row.set(TRANSLITERATED[i] as string, name);
    });
    out += csvLine(LEI2_HEADER.map((c) => row.get(c) ?? ""));
  }
  return out;
}

export type Relation = [child: string, parent: string, type: string, status?: string];

export function rrCsv(relations: readonly Relation[]): string {
  const header = [
    "Relationship.StartNode.NodeID",
    "Relationship.StartNode.NodeIDType",
    "Relationship.EndNode.NodeID",
    "Relationship.EndNode.NodeIDType",
    "Relationship.RelationshipType",
    "Relationship.RelationshipStatus",
  ];
  let out = csvLine(header);
  for (const [child, parent, type, status = "ACTIVE"] of relations) {
    out += csvLine([child, "LEI", parent, "LEI", type, status]);
  }
  return out;
}

export const ELF_CSV = `﻿${csvLine([
  "ELF Code",
  "Country of formation",
  "Entity Legal Form name Local name",
  "Language",
  "Entity Legal Form name Transliterated name (per ISO 01-140-10)",
  "Abbreviations Local language",
  "Abbreviations transliterated",
])}${csvLine(["XJHM", "Sweden", "Aktiebolag", "Swedish", "Aktiebolag", "AB", ""])}${csvLine(["8888", "", "", "", "", "", ""])}${csvLine(["ABCD", "Russia", "", "Russian", "Obshchestvo", "", "OOO"])}${csvLine(["XJHM", "Sweden", "Aktiebolag (engelska)", "English", "", "", ""])}`;

export const RA_CSV = `﻿${csvLine([
  "Registration Authority Code",
  "Country",
  "International name of Register",
  "Local name of Register",
  "International name of organisation responsible for the Register",
  "Local name of organisation responsible for the Register",
])}${csvLine(["RA000544", "Sweden", "Companies Register", "", "Swedish Companies Registration Office", "Bolagsverket"])}${csvLine(["RA000421", "Kyrgyzstan", "United State Register", "", "", ""])}${csvLine(["RA999999", "", "", "", "", ""])}`;

export interface Golden {
  specs: Spec[];
  relations: Relation[];
  /** LEI -> number of ISIN rows. */
  isins: Record<string, number>;
  bics: string[];
}

/** Write a golden copy, as the files `localInputs` looks for, and say where they are. */
export function writeInputs(dir: string, golden: Golden, asOf = "2026-09-16"): Inputs {
  mkdirSync(dir, { recursive: true });
  const at = (name: string) => join(dir, name);
  writeFileSync(
    at("lei2.csv.zip"),
    zipOf("20260916-0800-gleif-goldencopy-lei2-golden-copy.csv", lei2Csv(golden.specs)),
  );
  writeFileSync(
    at("rr.csv.zip"),
    zipOf("20260916-0800-gleif-goldencopy-rr-golden-copy.csv", rrCsv(golden.relations)),
  );
  const isinRows = Object.entries(golden.isins).flatMap(([lei, n]) =>
    Array.from({ length: n }, (_, i) => csvLine([lei, `XS${String(i).padStart(10, "0")}`])),
  );
  writeFileSync(
    at("isin-lei.zip"),
    zipOf("lei-isin-20260929T071510.csv", csvLine(["LEI", "ISIN"]) + isinRows.join("")),
  );
  writeFileSync(
    at("bic-lei.zip"),
    zipOf(
      "lei-bic.csv",
      csvLine(["LEI", "BIC"]) + golden.bics.map((l) => csvLine([l, "ABCDSESSXXX"])).join(""),
    ),
  );
  writeFileSync(at("elf-raw.csv"), ELF_CSV);
  writeFileSync(at("ra-list.csv"), RA_CSV);
  return {
    lei2: at("lei2.csv.zip"),
    rr: at("rr.csv.zip"),
    isin: at("isin-lei.zip"),
    bic: at("bic-lei.zip"),
    elf: at("elf-raw.csv"),
    ra: at("ra-list.csv"),
    asOf,
    records: undefined,
  };
}

// ---- The fixture golden copy ------------------------------------------------------

export const LEI = {
  maersk: "MAERSK00000000000001",
  ericsson: "ERICSSON000000000002",
  ericssonSweden: "ERICSSWEDEN000000003",
  fund: "FUND0000000000000004",
  inactive: "INACTIVE000000000005",
  quoted: "QUOTED00000000000006",
  noTerm: "NOTERM00000000000007",
  gazprom: "GAZPROM0000000000008",
  unknownStatus: "UNKNOWN0000000000009",
  previous: "PREVIOUS000000000010",
} as const;

/** Fillers that share three words, so three index files hold more than the cap. */
export const FILLERS = 1600;
export const fillerLei = (n: number) => `ACME${String(n).padStart(16, "0")}`;

export function fixtureGolden(): Golden {
  const specs: Spec[] = [
    {
      lei: LEI.maersk,
      name: "A.P. Møller - Mærsk A/S",
      country: "DK",
      registered: "2010-06-01T00:00:00.000Z",
      others: [
        ["Maersk", "TRADING_OR_OPERATING_NAME"],
        ["AP Moeller Maersk", "TRADING_OR_OPERATING_NAME"],
        ["Maersk", "TRADING_OR_OPERATING_NAME"],
      ],
    },
    {
      lei: LEI.ericsson,
      name: "Telefonaktiebolaget LM Ericsson",
      others: [["Ericsson", "TRADING_OR_OPERATING_NAME"]],
      registered: "2012-11-06T09:18:00.000Z",
    },
    { lei: LEI.ericssonSweden, name: "Ericsson Sweden AB", registration: "LAPSED" },
    {
      lei: LEI.fund,
      name: "Ericsson Growth Fund",
      category: "FUND",
      registration: "RETIRED",
      registered: "2020-12-31T00:00:00.000Z",
    },
    { lei: LEI.inactive, name: "Ericsson Dormant Oy", country: "FI", entityStatus: "INACTIVE" },
    // A quote, a comma and a line break inside one field.
    { lei: LEI.quoted, name: 'Quote "Q", Inc.\nDivision\tNorth', country: "US" },
    // No word of two characters or more: nothing to find it by. ("X & Y" would merge to "xy".)
    { lei: LEI.noTerm, name: "X", country: "US" },
    {
      lei: LEI.gazprom,
      name: "Газпром",
      country: "RU",
      others: [["Gazprom Export", "ALTERNATIVE_LANGUAGE_LEGAL_NAME"]],
      transliterated: ["Gazprom", "Gazprom Export"],
    },
    {
      lei: LEI.unknownStatus,
      name: "Mystery Holding",
      registration: "SOMETHING_NEW",
      country: "NO",
    },
    {
      lei: LEI.previous,
      name: "Newname Corporation",
      others: [
        ["Oldname Corporation", "PREVIOUS_LEGAL_NAME"],
        ["Newname Trading", "TRADING_OR_OPERATING_NAME"],
        ["Newname Corporation", "ALTERNATIVE_LANGUAGE_LEGAL_NAME"],
      ],
    },
  ];
  for (let n = 1; n <= FILLERS; n++) {
    specs.push({ lei: fillerLei(n), name: `Acme Holdings ${n} Limited`, country: "GB" });
  }
  return {
    specs,
    relations: [
      [LEI.ericssonSweden, LEI.ericsson, "IS_DIRECTLY_CONSOLIDATED_BY"],
      [LEI.fund, LEI.ericsson, "IS_ULTIMATELY_CONSOLIDATED_BY"],
      [LEI.inactive, LEI.ericsson, "IS_ULTIMATELY_CONSOLIDATED_BY", "INACTIVE"],
      [LEI.fund, LEI.maersk, "IS_FUND-MANAGED_BY"],
      [LEI.previous, LEI.maersk, "IS_INTERNATIONAL_BRANCH_OF"],
      [fillerLei(1000), LEI.maersk, "IS_DIRECTLY_CONSOLIDATED_BY"],
      [fillerLei(1001), LEI.maersk, "IS_DIRECTLY_CONSOLIDATED_BY"],
    ],
    isins: { [LEI.maersk]: 40, [LEI.ericsson]: 3 },
    bics: [LEI.maersk, LEI.ericsson],
  };
}
