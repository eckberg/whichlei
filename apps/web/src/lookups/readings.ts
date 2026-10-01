// What an input could be, for the GLEIF lookups. No DOM, no network.
import { identifierReadings } from "@whichlei/core";

/** `reg.no` is a national business register number. */
export type ReadingKind = "lei" | "isin" | "bic" | "reg.no";

export interface LookupReading {
  kind: ReadingKind;
  /** The code as the lookup sends it: normalised for an LEI, ISIN and BIC, trimmed for a register number. */
  code: string;
}

/** Longest input that is looked up at all. The longest identifier GLEIF holds is 35 characters. */
export const MAX_LOOKUP_LENGTH = 35;

const REGISTER_CHARS = /^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/;
const ISIN_SHAPE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;
/** An LEI, or one with a character missing. 18 stays: a Chinese unified social credit code. */
const LEI_LENGTH = /^[0-9A-Z]{19,20}$/;
const YEAR = /^(19|20)\d{2}$/;

/** The key a reading is cached and deduplicated by. Register numbers ignore case. */
export const readingKey = (reading: LookupReading): string =>
  `${reading.kind}:${reading.code.toUpperCase()}`;

/**
 * A register number as typed, or null. Register numbers have no check digit and no fixed
 * shape ("556016-0680", "HRB 86891", "SC123456"), so the rule is loose but must keep names
 * out, because a register number goes to GLEIF (DESIGN.md decision 25):
 * - at least 5 characters, only letters, digits, spaces and `. - /`;
 * - at least 5 digits, and digits at least half of the letters and digits;
 * - not only years: if the input has runs of 4 or more digits, at least one is not a year of
 *   1900 to 2099 ("Fund 2021", "AP7 2021" and "ETF 2025" are names);
 * - not 19 or 20 letters and digits in one piece: an LEI, or one with a character missing
 *   (also not the shape of an ISIN, whether or not its check digit holds).
 */
export function registerNumber(input: string): string | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length < 5 || !REGISTER_CHARS.test(text)) return null;
  const compact = text.replace(/\s+/g, "").toUpperCase();
  if (LEI_LENGTH.test(compact) || ISIN_SHAPE.test(compact)) return null;
  const alphanumeric = text.replace(/[^A-Za-z0-9]/g, "").length;
  const digits = text.replace(/\D/g, "").length;
  if (digits < 5 || digits * 2 < alphanumeric) return null;
  const long = text.match(/\d{4,}/g) ?? [];
  if (long.length > 0 && long.every((run) => YEAR.test(run))) return null;
  return text;
}

/**
 * The lookups an input calls for, in the order their rows are shown. Names are not here: the
 * index searches those. Which reading is real is decided by what GLEIF answers (DESIGN.md
 * decision 8), so every possible one is returned. An input longer than any identifier has none.
 */
export function lookupReadings(input: string): LookupReading[] {
  if (input.trim().length > MAX_LOOKUP_LENGTH) return [];
  const { lei, isin, bic } = identifierReadings(input);
  const out: LookupReading[] = [];
  if (lei) out.push({ kind: "lei", code: lei });
  if (isin) out.push({ kind: "isin", code: isin });
  if (bic) out.push({ kind: "bic", code: bic });
  const regNo = registerNumber(input);
  if (regNo) out.push({ kind: "reg.no", code: regNo });
  return out;
}
