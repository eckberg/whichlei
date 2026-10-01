// What an input could be, for the GLEIF lookups. No DOM, no network.
import { identifierReadings } from "@whichlei/core";

/** `reg.no` is a national business register number. */
export type ReadingKind = "lei" | "isin" | "bic" | "reg.no";

export interface LookupReading {
  kind: ReadingKind;
  /** The code as the lookup sends it: normalised for an LEI, ISIN and BIC, trimmed for a register number. */
  code: string;
}

const REGISTER_CHARS = /^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/;
const LEI_SHAPE = /^[0-9A-Z]{18}[0-9]{2}$/;
const ISIN_SHAPE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

/** The key a reading is cached and deduplicated by. Register numbers ignore case. */
export const readingKey = (reading: LookupReading): string =>
  `${reading.kind}:${reading.code.toUpperCase()}`;

/**
 * A register number as typed, or null. Register numbers have no check digit and no fixed
 * shape ("556016-0680", "HRB 86891", "SC123456"), so the rule is loose: at least five
 * characters, only letters, digits, spaces and `. - /`, at least four digits, and digits are
 * at least half of the letters and digits ("AST Bond Portfolio 2021" is a name). An input that
 * has the shape of an LEI or an ISIN is not one, whether or not its check digits hold.
 */
export function registerNumber(input: string): string | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length < 5 || !REGISTER_CHARS.test(text)) return null;
  const compact = text.replace(/\s+/g, "").toUpperCase();
  if (LEI_SHAPE.test(compact) || ISIN_SHAPE.test(compact)) return null;
  const alphanumeric = text.replace(/[^A-Za-z0-9]/g, "").length;
  const digits = text.replace(/\D/g, "").length;
  return digits >= 4 && digits * 2 >= alphanumeric ? text : null;
}

/**
 * The lookups an input calls for, in the order their rows are shown. Names are not here: the
 * index searches those. Which reading is real is decided by what GLEIF answers (DESIGN.md
 * decision 8), so every possible one is returned.
 */
export function lookupReadings(input: string): LookupReading[] {
  const { lei, isin, bic } = identifierReadings(input);
  const out: LookupReading[] = [];
  if (lei) out.push({ kind: "lei", code: lei });
  if (isin) out.push({ kind: "isin", code: isin });
  if (bic) out.push({ kind: "bic", code: bic });
  const regNo = registerNumber(input);
  if (regNo) out.push({ kind: "reg.no", code: regNo });
  return out;
}
