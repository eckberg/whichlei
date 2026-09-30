// Normalisation and tokenisation. Port of research/ranking/ranking.py, section 1.
// The indexer and the browser must produce identical tokens, so both use this file.

// NFKD does not decompose these, so fold them explicitly first.
const FOLD: Record<string, string> = {
  æ: "ae",
  Æ: "ae",
  ø: "o",
  Ø: "o",
  ß: "ss",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  þ: "th",
  Þ: "th",
  œ: "oe",
  Œ: "oe",
  ı: "i",
  ŋ: "n",
  ħ: "h",
  ŧ: "t",
};
const FOLD_CHARS = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");
const COMBINING = /\p{Mn}/gu;
// Python's str.split() whitespace. JavaScript's \s is a different set.
const WHITESPACE = new RegExp(
  `[${String.fromCodePoint(
    ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680],
    ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
    ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000],
  )}]+`,
);
const TRAILING_WHITESPACE = new RegExp(`${WHITESPACE.source}$`);
const ALNUM = /[a-z0-9]+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the whole ASCII range
const ASCII = /^[\x00-\x7f]*$/;

/** Fold for matching: the explicit table, NFKD, drop combining marks, lower case. */
export function fold(text: string): string {
  // ASCII has nothing to fold or decompose. Most names are ASCII, and the index parses
  // thousands of them per file.
  if (ASCII.test(text)) return text.toLowerCase();
  return text
    .replace(FOLD_CHARS, (char) => FOLD[char] ?? char)
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase();
}

/** Python's str.split(): split on whitespace runs, drop empty strings. */
function split(text: string): string[] {
  return text.split(WHITESPACE).filter((chunk) => chunk !== "");
}

/** ['h', 'm', 'hennes'] -> ['hm', 'hennes']; 'L M Ericsson' -> ['lm', 'ericsson']. */
function mergeSingleLetters(runs: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < runs.length) {
    if (runs[i]?.length === 1) {
      let j = i;
      while (j < runs.length && runs[j]?.length === 1) j++;
      out.push(runs.slice(i, j).join(""));
      i = j;
    } else {
      out.push(runs[i] ?? "");
      i++;
    }
  }
  return out;
}

/** A chunk whose alphanumeric runs are all one or two characters: 'AT&T', 'E.ON', 'S.A.'. */
function isShortRuns(runs: string[]): boolean {
  return runs.length >= 2 && runs.every((run) => run.length <= 2);
}

export interface NameTokens {
  /** Canonical token sequence. 'AT&T' -> 'att'; adjacent single letters merge. */
  seq: string[];
  /** The other form of each multi-run chunk: 'Coca-Cola' -> 'cocacola'. Not positional. */
  extras: string[];
}

/** Tokens of an entity name. */
export function nameTokens(name: string): NameTokens {
  const runsAll: string[] = [];
  const extras: string[] = [];
  for (const chunk of split(fold(name))) {
    const runs = chunk.match(ALNUM);
    if (!runs) continue;
    if (isShortRuns(runs)) {
      runsAll.push(runs.join(""));
      extras.push(...runs);
    } else {
      runsAll.push(...runs);
      if (runs.length >= 2) extras.push(runs.join(""));
    }
  }
  const seq = mergeSingleLetters(runsAll);
  const seen = new Set(seq);
  return {
    seq,
    extras: [...new Set(extras)].filter((extra) => !seen.has(extra) && extra.length >= 2),
  };
}

/**
 * Whether the last query token is still being typed, and so is a prefix: false once the
 * text ends in whitespace (the same whitespace the tokeniser splits on). For `route`.
 */
export function lastIsPrefix(query: string): boolean {
  return !TRAILING_WHITESPACE.test(query);
}

/** Tokens of a typed query. 'h&m' is one token, 'coca-cola' two; single letters merge. */
export function queryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const chunk of split(fold(query))) {
    const runs = chunk.match(ALNUM);
    if (!runs) continue;
    if (isShortRuns(runs)) tokens.push(runs.join(""));
    else tokens.push(...runs);
  }
  return mergeSingleLetters(tokens);
}

/** Terms that place an entity into index files. Single characters are not indexed. */
export function indexTerms({ seq, extras }: NameTokens): Set<string> {
  return new Set([...seq, ...extras].filter((term) => term.length >= 2));
}
