const LEI_SHAPE = /^[0-9A-Z]{18}[0-9]{2}$/;

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
