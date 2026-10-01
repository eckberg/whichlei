// Names for the codes a record carries: legal forms (ISO 20275 ELF) and registration
// authorities. A page shows "Aktiebolag" and "Bolagsverket", not XJHM and RA000544.
// docs/index-format.md describes the file.
import { columnsOf, parseCsv } from "./csv.ts";

export interface Codes {
  /** ELF code to the legal form's name in its own language. */
  elf: Record<string, string>;
  /**
   * Registration authority code to the name of the organisation that keeps the register.
   * Absent when the list was not available to the build.
   */
  ra?: Record<string, string>;
}

/** First non-empty of the candidates, trimmed. */
const first = (...candidates: (string | undefined)[]): string =>
  candidates.map((c) => c?.trim() ?? "").find((c) => c !== "") ?? "";

/**
 * The ELF code list, one row per code and language. The name is the local name of the first
 * row that has one, else its transliterated name, else an abbreviation.
 */
export function readElf(csv: string | Uint8Array): Record<string, string> {
  const { header, rows } = parseCsv(csv);
  const k = columnsOf(header, [
    "ELF Code",
    "Entity Legal Form name Local name",
    "Entity Legal Form name Transliterated name (per ISO 01-140-10)",
    "Abbreviations Local language",
    "Abbreviations transliterated",
  ]);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const code = (row[k["ELF Code"]] ?? "").trim();
    if (code === "" || code in out) continue;
    const name = first(
      row[k["Entity Legal Form name Local name"]],
      row[k["Entity Legal Form name Transliterated name (per ISO 01-140-10)"]],
      row[k["Abbreviations Local language"]],
      row[k["Abbreviations transliterated"]],
    );
    // A code whose first row has no name may get one from a later row (another language).
    if (name !== "") out[code] = name;
  }
  return sorted(out);
}

/**
 * GLEIF's registration authorities list. The name is the local name of the organisation
 * responsible for the register, else its international name, else the register's name.
 */
export function readRegistrationAuthorities(csv: string | Uint8Array): Record<string, string> {
  const { header, rows } = parseCsv(csv);
  const k = columnsOf(header, [
    "Registration Authority Code",
    "International name of Register",
    "Local name of Register",
    "International name of organisation responsible for the Register",
    "Local name of organisation responsible for the Register",
  ]);
  const out: Record<string, string> = {};
  for (const row of rows) {
    const code = (row[k["Registration Authority Code"]] ?? "").trim();
    if (code === "") continue;
    const name = first(
      row[k["Local name of organisation responsible for the Register"]],
      row[k["International name of organisation responsible for the Register"]],
      row[k["International name of Register"]],
      row[k["Local name of Register"]],
    );
    if (name !== "" && !(code in out)) out[code] = name;
  }
  return sorted(out);
}

/** The same object with its keys in order, so two builds write the same bytes. */
function sorted(object: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** `codes.json`: compact, keys in order. */
export function encodeCodes(codes: Codes): string {
  return JSON.stringify(
    codes.ra === undefined
      ? { elf: sorted(codes.elf) }
      : { elf: sorted(codes.elf), ra: sorted(codes.ra) },
  );
}
