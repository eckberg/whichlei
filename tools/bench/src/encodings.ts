// Candidate encodings of one index file. Each turns the file's entries into text, and the
// text back into scoring candidates: everything the browser does before it scores.
// "lines" is the format in @whichlei/core; the others are the alternatives measured
// against it. Runs in Node and in the browser.
import {
  type Candidate,
  decodeEntries,
  type Entry,
  encodeEntries,
  type NameTokens,
  nameTokens,
  type Status,
  toCandidate,
} from "@whichlei/core";

export type Scored = Candidate<string>;

export interface Encoding {
  name: string;
  /** Written to disk for the browser timings; the others are only sized. */
  timed: boolean;
  encode(entries: readonly Entry[]): string;
  decode(text: string): Scored[];
}

const P10 = (p: number) => Math.round(p * 10);

/** The research format: [lei, legal name, country, round(P * 10), [other names]?]. */
const jsonResearch: Encoding = {
  name: "json-research",
  timed: false,
  encode: (entries) =>
    JSON.stringify(
      entries.map((e) => {
        const row: unknown[] = [e.lei, e.name, e.country, P10(e.prominence)];
        if (e.otherNames.length > 0) row.push(e.otherNames);
        return row;
      }),
    ),
  decode: () => {
    throw new Error("json-research is only sized");
  },
};

type JsonRow = [string, string, string, Status, number, string[]?];

/** The research format plus status, which the result list shows. */
const json: Encoding = {
  name: "json",
  timed: true,
  encode: (entries) =>
    JSON.stringify(
      entries.map((e) => {
        const row: JsonRow = [e.lei, e.name, e.country, e.status, P10(e.prominence)];
        if (e.otherNames.length > 0) row.push(e.otherNames);
        return row;
      }),
    ),
  decode: (text) =>
    (JSON.parse(text) as JsonRow[]).map(([lei, name, , , p10, other = []]) => ({
      id: lei,
      prominence: p10 / 10,
      names: [name, ...other].map(nameTokens),
    })),
};

/** One line per entry, tab-separated: the core format. */
const lines: Encoding = {
  name: "lines",
  timed: true,
  encode: encodeEntries,
  decode: (text) => decodeEntries(text).map(toCandidate),
};

/** As lines, with prominence in hundredths. Sized only. */
const linesP100: Encoding = {
  name: "lines-p100",
  timed: false,
  encode: (entries) =>
    entries
      .map(
        (e) =>
          `${[e.lei, Math.round(e.prominence * 100), e.country, e.status, e.name, ...e.otherNames].join("\t")}\n`,
      )
      .join(""),
  decode: () => {
    throw new Error("lines-p100 is only sized");
  },
};

/** As lines, entries sorted by legal name instead of prominence. Sized only. */
const linesByName: Encoding = {
  name: "lines-by-name",
  timed: false,
  encode: (entries) =>
    encodeEntries([...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))),
  decode: () => {
    throw new Error("lines-by-name is only sized");
  },
};

/**
 * As lines, and every name followed by its tokens, so the browser does not tokenise:
 * lei, P10, country, status, then per name: name, seq tokens, extra tokens (space-joined).
 */
const linesTokens: Encoding = {
  name: "lines-tokens",
  timed: true,
  encode: (entries) =>
    entries
      .map((e) => {
        const fields = [e.lei, String(P10(e.prominence)), e.country, e.status];
        for (const name of [e.name, ...e.otherNames]) {
          const { seq, extras } = nameTokens(name);
          fields.push(name, seq.join(" "), extras.join(" "));
        }
        return `${fields.join("\t")}\n`;
      })
      .join(""),
  decode: (text) => {
    const out: Scored[] = [];
    const words = (s: string | undefined) => (s ? s.split(" ") : []);
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const f = line.split("\t");
      const names: NameTokens[] = [];
      for (let i = 4; i < f.length; i += 3)
        names.push({ seq: words(f[i + 1]), extras: words(f[i + 2]) });
      out.push({ id: f[0] ?? "", prominence: Number(f[1]) / 10, names });
    }
    return out;
  },
};

export const ENCODINGS: readonly Encoding[] = [
  jsonResearch,
  json,
  lines,
  linesP100,
  linesByName,
  linesTokens,
];

export function encoding(name: string): Encoding {
  const found = ENCODINGS.find((e) => e.name === name);
  if (!found) throw new Error(`unknown encoding ${name}`);
  return found;
}
