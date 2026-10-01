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

/**
 * Tokens that end a name as its legal form: 'AB', 'GmbH & Co. KG', 'S.p.A.', 'Sp. z o.o.',
 * 'Aktiengesellschaft', 'Corporation', as nameTokens writes them. The frequent last words of
 * legal names in the golden copy that are legal forms, and the words of spelled-out forms.
 */
export const LEGAL_FORMS: ReadonlySet<string> = new Set(
  `ab aktiebolag aktiebolaget publ as asa aps oy oyj osakeyhtio ehf hf
  gmbh mbh ggmbh ag kg kgaa ohg gbr ug haftungsbeschrankt eg ev co se
  aktiengesellschaft kommanditgesellschaft gesellschaft mit beschrankter haftung
  ltd limited plc llc llp lp inc incorporated corp corporation company public pte pty pvt private
  sa sas sasu sarl eurl sca scs snc sci scop societe anonyme spa srl srls sapa
  sl slu slp sau ltda limitada lda sociedad sociedade anonima por acoes unipessoal unipersonal eireli
  bv nv vof cv cvba bvba naamloze besloten vennootschap sro ks vos akciova spolecnost
  sp z oo spolka akcyjna ograniczona odpowiedzialnoscia komandytowa jawna
  kft zrt nyrt rt tarsasag felelossegu korlatolt reszvenytarsasag mukodo nyilvanosan
  doo dd ad ood eood ou uab sia bhd sdn kk`
    .trim()
    .split(/\s+/),
);

/**
 * Where the trailing legal form of a name starts: the first word of the run of LEGAL_FORMS
 * at its end, or `seq.length` when it has none. Never 0: a name that is all legal form
 * keeps its first word ('SAS AB' -> 1, 'AB' -> 1).
 */
export function formStart(seq: readonly string[]): number {
  let start = seq.length;
  while (start > 1 && LEGAL_FORMS.has(seq[start - 1] as string)) start--;
  return start;
}

/** Initials have this many letters at least, and at most. */
export const INITIALS_LENGTH = { min: 3, max: 6 } as const;
const LETTER = /^[a-z]/;

/**
 * Initials of a name, for acronyms: the first letter of each word, `stop` words left out.
 * Once without the trailing legal form, and once with its first word when that is spelled
 * out (four letters or more), as in BBC and HSBC. 'Skandinaviska Enskilda Banken AB' ->
 * ['seb']; 'British Broadcasting Corporation' -> ['bb', 'bbc']; 'International Business
 * Machines Corporation' -> ['ibm', 'ibmc']. INITIALS_LENGTH words, each starting with a
 * letter; else none.
 */
export function nameInitials(seq: readonly string[], stop: ReadonlySet<string>): string[] {
  const start = formStart(seq);
  const words = seq.slice(0, start).filter((word) => !stop.has(word));
  if (!words.every((word) => LETTER.test(word))) return [];
  const form = seq[start];
  const variants = [words];
  if (form !== undefined && form.length >= 4) variants.push([...words, form]);
  return variants
    .filter((v) => v.length >= INITIALS_LENGTH.min && v.length <= INITIALS_LENGTH.max)
    .map((v) => v.map((word) => word[0]).join(""));
}
