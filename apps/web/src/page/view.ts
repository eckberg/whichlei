// What the search page shows, as HTML strings: a pure function of the search state, so it
// is tested without a browser. Every value goes through `html`, which escapes; the index is
// data, not markup.
import { escapeHtml, type Html, html, raw } from "../html.ts";
import { type LookupSummary, NO_LOOKUPS } from "../lookups/compose.ts";
import { type Hit, namesOf, statusOf } from "../search/entry.ts";
import { nameMarks, type Range } from "../search/highlight.ts";
import { RESULT_LIMIT, type SearchState } from "../search/search.ts";

export type View = "search" | "about";

const count = new Intl.NumberFormat("en-US");
export const fmt = (n: number): string => count.format(n);

/** `text` with `<mark>` around each range. Ranges are sorted and do not overlap. */
export function markHtml(text: string, ranges: readonly Range[]): Html {
  if (ranges.length === 0) return raw(escapeHtml(text));
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    out += `${escapeHtml(text.slice(at, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return raw(out + escapeHtml(text.slice(at)));
}

/** The name column of a result row: the legal name, marked, or the other name that matched. */
function nameCell(hit: Hit, tokens: readonly string[]): Html {
  const { entry } = hit;
  // The row of an LEI typed in full, until GLEIF has said whose it is.
  if (hit.typed && entry.name === "") {
    return html`<span class="aka">check digits ok · open the record</span>`;
  }
  // Found at GLEIF by a code, not by words: nothing in the name is a match to mark.
  if (hit.typed || hit.via) {
    return html`${hit.via ? html`<span class="aka via">${hit.via}</span> ` : ""}${entry.name}`;
  }
  const marks = nameMarks(tokens, entry.name, entry.otherNames);
  const legal = markHtml(entry.name, marks.legal);
  if (!marks.aka) return legal;
  return html`${legal} <span class="aka">(${markHtml(marks.aka.name, marks.aka.ranges)})</span>`;
}

/**
 * One result row. The selected one has a pointer and is reverse video (CSS). `total` is the
 * number of results, so a screen reader says "3 of 50".
 */
export function rowHtml(
  hit: Hit,
  tokens: readonly string[],
  k: number,
  selected: boolean,
  total: number,
): Html {
  const { entry } = hit;
  const status = hit.status ?? (hit.typed ? null : statusOf(entry.status));
  return html`<div class="row" role="option" id="opt-${k}" data-k="${k}" aria-setsize="${total}" aria-posinset="${k + 1}" aria-selected="${String(selected)}"><span class="ptr" aria-hidden="true">${selected ? ">" : ""}</span><span class="lei">${entry.lei}</span><span class="nm">${nameCell(hit, tokens)}</span><span class="cc">${entry.country}</span><span class="st st-${status?.tone ?? ""}">${status?.label ?? ""}</span></div>`;
}

export function rowsHtml(
  hits: readonly Hit[],
  tokens: readonly string[],
  selected: number,
): string {
  let out = "";
  for (const [k, hit] of hits.entries())
    out += rowHtml(hit, tokens, k, k === selected, hits.length).value;
  return out;
}

let regions: Intl.DisplayNames | null | undefined;
/** "Sweden" for "SE", or nothing when the browser cannot say. */
function countryName(code: string): string {
  if (regions === undefined) {
    try {
      regions = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regions = null;
    }
  }
  try {
    const name = regions?.of(code);
    return name && name !== code ? name : "";
  } catch {
    return "";
  }
}

export const recordHref = (lei: string): string => `/lei/${encodeURIComponent(lei)}`;

/** The preview pane: what the index, or a lookup at GLEIF, holds about the selected result. */
export function previewHtml(hit: Hit | undefined): string {
  if (!hit) return "";
  const { entry } = hit;
  const actions = html`<div class="actions"><button class="btn" type="button" data-act="copy">copy lei</button><a class="btn" href="${recordHref(entry.lei)}" data-act="open">open record</a></div>`;
  if (hit.typed && entry.name === "") {
    return html`<div class="pane"><span class="label">${entry.lei}</span><p class="note">check digits ok. The record is fetched from GLEIF when you open it.</p>${actions}</div>`
      .value;
  }
  const status = hit.status ?? statusOf(entry.status);
  const others = namesOf(entry).slice(1);
  const country = countryName(entry.country);
  const rows: Html[] = [
    html`<dt>name</dt><dd>${entry.name}</dd>`,
    others.length > 0 ? html`<dt>also</dt><dd>${others.join(" · ")}</dd>` : html``,
    entry.country
      ? html`<dt>country</dt><dd>${entry.country}${country ? ` · ${country}` : ""}</dd>`
      : html``,
    html`<dt>status</dt><dd><span class="st-${status.tone}">${status.label}</span></dd>`,
    hit.via ? html`<dt>found by</dt><dd>${hit.via}, at GLEIF</dd>` : html``,
    hit.typed ? html`<dt>checked</dt><dd>check digits ok, found at GLEIF</dd>` : html``,
  ];
  return html`<div class="pane"><span class="label">${entry.lei}</span><dl class="kv">${rows}</dl>${actions}</div>`
    .value;
}

const EXAMPLES: readonly [query: string, about: string][] = [
  ["ericsson", "name"],
  ["h&m", "brand name"],
  ["HWUPKR0MPOU8FGXBT394", "lei"],
  ["US0378331005", "isin"],
  ["TEERSESSXXX", "bic"],
  ["556016-0680", "swedish register number"],
  ["HWUPKR0MPOU8FGXBT395", "lei with a typo"],
];

/** The empty state: one line of usage and examples to click. */
export function usageHtml(): string {
  return html`<div class="doc"><p class="lead">type a name, an lei, an isin, a bic or a national register number.</p><h2>examples</h2><div class="examples">${EXAMPLES.map(
    ([query, about]) =>
      html`<button type="button" data-q="${query}">${query}</button><span>${about}</span>`,
  )}</div></div>`.value;
}

const KEYS: readonly [key: string, does: string][] = [
  ["↑ ↓", "move the selection"],
  ["enter", "copy the selected LEI"],
  ["→", "open the record"],
  ["esc", "clear the search, or go back"],
  ["/", "jump to the search field"],
  ["?", "this page, when the search is empty"],
  ["q", "leave this page"],
];

/** The about page, set like a man page. */
export function aboutHtml(index: SearchState["index"]): string {
  const asOf = index?.asOf ?? "";
  const data = index
    ? html`<p>This search runs on the golden copy of ${index.asOf}: ${fmt(index.entities)} entities.</p>`
    : html``;
  return html`<div class="doc" id="man"><div class="man-head"><span>WHICHLEI(1)</span><span>User Commands</span><span>WHICHLEI(1)</span></div>
<h2>NAME</h2><p>whichlei – find the Legal Entity Identifier of a company, fund or public body</p>
<h2>SYNOPSIS</h2><p>type a name, an LEI, an ISIN, a BIC or a national register number</p>
<h2>DESCRIPTION</h2><p>Results appear as you type, best match first. Press enter to copy its LEI.</p>
<p>An LEI is a 20-character code defined by ISO 17442. Its last two characters are check digits (ISO 7064 mod 97-10), so a mistyped LEI is caught in your browser before anything is looked up.</p>
<p>An ISIN, a BIC or a register number is looked up at GLEIF, which lists the entity behind it. A name that looks like none of them is only searched in the index.</p>
<h2>KEYS</h2><dl class="keys">${KEYS.map(([key, does]) => html`<dt>${key}</dt><dd>${does}</dd>`)}</dl>
<h2>DATA</h2><p>Every record comes from GLEIF, the Global Legal Entity Identifier Foundation. The search index is rebuilt daily from GLEIF’s golden copy, published under CC0. An opened record is fetched live from the GLEIF API.</p>${data}
<h2>PRIVACY</h2><p>No account and no cookies. Name search runs in your browser, on files from the index host. When what you type looks like an LEI, an ISIN, a BIC or a register number, it is also sent to the GLEIF API (api.gleif.org), after a short pause, to look it up. Nothing else you type goes anywhere. Analytics are cookieless and aggregate, and never see what you type.</p>
<h2>SEE ALSO</h2><p><a href="https://www.gleif.org" target="_blank" rel="noopener">gleif.org</a>, <a href="https://search.gleif.org" target="_blank" rel="noopener">search.gleif.org</a></p>
<div class="man-head foot"><span>whichlei</span><span>${asOf}</span><span>WHICHLEI(1)</span></div></div>`
    .value;
}

/** The key bar for the current screen. */
export function keysHtml(view: View, searching: boolean): string {
  const items: readonly [string, string][] =
    view === "about"
      ? [
          ["q", "quit"],
          ["esc", "back"],
        ]
      : searching
        ? [
            ["↑↓", "select"],
            ["⏎", "copy lei"],
            ["→", "open record"],
            ["esc", "clear"],
          ]
        : [
            ["/", "search"],
            ["?", "about"],
          ];
  return items.map(([key, does]) => html`<li><kbd>${key}</kbd>${does}</li>`.value).join("");
}

/** The footer: which index the results come from. */
export function metaText(index: SearchState["index"]): string {
  return index ? `index: ${fmt(index.entities)} entities · gleif ${index.asOf}` : "";
}

export type Tone = "ok" | "bad" | "warn" | "";

const hitCount = (shown: number, total: number): string =>
  total > shown ? `top ${shown} of ${fmt(total)}` : shown === 1 ? "1 hit" : `${fmt(shown)} hits`;

/** What the lookups at GLEIF add to the line under the prompt: what they found, then what failed. */
function lookupParts(lookups: LookupSummary): { news: [Html, string][]; failed: [Html, string][] } {
  const news: [Html, string][] = lookups.found.map(({ kind, shown, total }) => {
    const text = `${kind} · ${hitCount(shown, total)}`;
    return [html`${text}`, text];
  });
  if (lookups.leiMissing) {
    news.push([html`<span class="warn">no such LEI at GLEIF</span>`, "no such LEI at GLEIF"]);
  }
  const failed: [Html, string][] = [];
  if (lookups.failure) {
    const text =
      lookups.failure === "busy" ? "GLEIF is busy, try again in a minute" : "could not reach GLEIF";
    failed.push([
      html`<span class="warn">${text}</span><button class="btn" type="button" data-act="retry-lookup">retry</button>`,
      text,
    ]);
  }
  return { news, failed };
}

const joined = (parts: [Html, string][]) => ({
  html: raw(parts.map(([markup]) => markup.value).join(" · ")),
  text: parts.map(([, text]) => text).join(" · "),
});

/**
 * The line under the prompt: how many matches, or what is wrong. `lookups` is what the
 * lookups at GLEIF found, if there are any.
 */
export function infoLine(
  state: SearchState,
  lookups: LookupSummary = NO_LOOKUPS,
): { html: Html; text: string; tone: Tone } {
  // Matches by name; the row of a valid LEI and the rows of lookups are not.
  const n = state.hits.filter((hit) => !hit.typed && !hit.via).length;
  const matches =
    n === 1 ? "1 match" : n >= RESULT_LIMIT ? `top ${n} matches` : `${fmt(n)} matches`;
  const { news, failed } = lookupParts(lookups);
  const extra = [...news, ...failed];
  // With nothing to show, the lookups' news replaces "no matches", or says they are at work.
  const instead = (fallback: { html: Html; text: string; tone: Tone }) => {
    if (extra.length > 0) return { ...joined(extra), tone: "" as Tone };
    if (lookups.pending) return line("looking up at GLEIF…", "");
    return fallback;
  };
  switch (state.phase) {
    case "empty":
      return { html: html``, text: "", tone: "" };
    case "unconfigured":
      return instead(
        line("no index is set up for this build, so names cannot be searched", "warn"),
      );
    case "loading":
      return line("searching…", "");
    case "short":
      return instead(line("type a little more", ""));
    case "bad-lei":
      return line("not a valid lei: the check digits don’t match (iso 7064 mod 97-10)", "bad");
    case "no-match":
      return instead(line(state.message || "no matches", ""));
    case "error": {
      // The index failed; what the lookups found, or could not do, is still worth saying.
      const own: [Html, string][] = [
        [
          html`<span class="bad">${state.message}</span><button class="btn" type="button" data-act="${state.reload ? "reload" : "retry"}">${state.reload ? "reload" : "retry"}</button>`,
          state.message,
        ],
      ];
      return { ...joined([...own, ...extra]), tone: "bad" };
    }
    case "done": {
      const parts: [Html, string][] = [];
      if (state.lei === "valid" && !lookups.leiMissing) {
        parts.push([html`lei · <span class="ok">check digits ok</span>`, "lei, check digits ok"]);
      }
      // What the lookups found goes first, as their rows do; what failed goes last.
      parts.push(...news);
      if (n > 0) parts.push([html`${matches}`, matches]);
      if (state.lei === "invalid") {
        const note = "not a valid lei: the check digits don’t match";
        parts.push([html`<span class="warn">${note}</span>`, note]);
      }
      parts.push(...failed);
      return {
        ...joined(parts),
        tone: state.lei === "valid" && n === 0 && extra.length === 0 ? "ok" : "",
      };
    }
  }
}

function line(text: string, tone: Tone): { html: Html; text: string; tone: Tone } {
  return { html: tone ? html`<span class="${tone}">${text}</span>` : html`${text}`, text, tone };
}

/** What a screen reader hears once the results settle. Null while still searching. */
export function announcement(
  state: SearchState,
  lookups: LookupSummary = NO_LOOKUPS,
): string | null {
  switch (state.phase) {
    case "loading":
    case "empty":
      return null;
    case "short":
      return lookups.failure || lookups.leiMissing ? infoLine(state, lookups).text : null;
    case "done":
      return state.hits[0]?.typed && lookups.found.length === 0 && !lookups.failure
        ? "valid lei, press enter to copy it"
        : infoLine(state, lookups).text;
    default:
      return infoLine(state, lookups).text;
  }
}
