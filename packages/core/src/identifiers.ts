// Identifier checks. They say which readings of an input are possible; lookups decide
// which is real (DESIGN.md decision 8: "ERICSSON" is also a valid BIC).

const LEI_SHAPE = /^[0-9A-Z]{18}[0-9]{2}$/;
const ISIN_SHAPE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;
const BIC_SHAPE = /^[0-9A-Z]{4}([A-Z]{2})[0-9A-Z]{2}([0-9A-Z]{3})?$/;

// ISO 3166-1 alpha-2, plus XK (Kosovo), which BICs use.
const COUNTRIES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ
  BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM
  DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS
  GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
  KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ
  MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM
  PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV
  SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
  VN VU WF WS XK YE YT ZA ZM ZW`.split(/\s+/),
);

/**
 * True if `code` is a well-formed LEI whose check digits verify (ISO 17442, ISO 7064
 * mod 97-10). Expects upper case with no spaces; normalise input before calling.
 */
export function isValidLei(code: string): boolean {
  if (!LEI_SHAPE.test(code)) return false;
  // No 02–98 range check on the check digits: issued LEIs end in 00 and 01 too
  // (315700PN3J57ZUNF1V00, 31570010000000116301).
  // Letters count as two digits (A = 10 … Z = 35). Reduce as we go to stay within a double.
  let remainder = 0;
  for (const char of code) {
    const value = Number.parseInt(char, 36);
    remainder = (remainder * (value < 10 ? 10 : 100) + value) % 97;
  }
  return remainder === 1;
}

/**
 * True if `code` is a well-formed ISIN whose check digit verifies (ISO 6166: letters become
 * two digits, A = 10 … Z = 35, then Luhn). The prefix is not checked against a country
 * list: ISINs also use XS, EU and others. Expects upper case with no spaces.
 */
export function isValidIsin(code: string): boolean {
  if (!ISIN_SHAPE.test(code)) return false;
  let digits = "";
  for (const char of code) digits += Number.parseInt(char, 36).toString();
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * True if `code` has the shape of a BIC (ISO 9362): party prefix, a country code, location,
 * optional branch. BICs have no check digit, so a word like "ERICSSON" also passes.
 * Expects upper case with no spaces.
 */
export function isValidBic(code: string): boolean {
  const country = BIC_SHAPE.exec(code)?.[1];
  return country !== undefined && COUNTRIES.has(country);
}

export interface IdentifierReadings {
  lei?: string;
  isin?: string;
  bic?: string;
}

// A BIC written in its groups: party (4), country (2), location (2), branch (3, optional),
// one space between groups. Any other spacing is not a BIC: "Sony Corp" and "Barclays PLC" are
// names that become BIC shapes once their spaces are gone.
const BIC_GROUPED = /^\S{4} \S{2} \S{2}( \S{3})?$/;

// An LEI written in groups of four, as it is printed: five groups, one space between them.
const LEI_GROUPED = /^\S{4}( \S{4}){4}$/;

/**
 * Every identifier an input could be, normalised: upper case, spaces removed. More than one
 * reading is possible; an input with none is a name or a register number. Spaces are allowed
 * only where the identifier is written with them, so a name does not turn into a code: an LEI
 * between groups of 4, a BIC between all its groups (4, 2, 2 and 3 characters), an ISIN never.
 */
export function identifierReadings(input: string): IdentifierReadings {
  // Upper-case a-z only: toUpperCase() would turn "ß" into "SS" and "ı" into "I".
  const code = input.replace(/\s+/g, "").replace(/[a-z]/g, (char) => char.toUpperCase());
  const trimmed = input.trim();
  const spaced = /\s/.test(trimmed);
  const readings: IdentifierReadings = {};
  if ((!spaced || LEI_GROUPED.test(trimmed)) && isValidLei(code)) readings.lei = code;
  if (!spaced && isValidIsin(code)) readings.isin = code;
  if ((!spaced || BIC_GROUPED.test(trimmed)) && isValidBic(code)) readings.bic = code;
  return readings;
}
