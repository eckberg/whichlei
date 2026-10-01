// What the search page shows, as HTML strings: a pure function of the search state, so it
// is tested without a browser. Every value goes through `html`, which escapes; the index is
// data, not markup.
import { escapeHtml, type Html, html, raw } from "../html.ts";
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
  if (hit.typed) return html`<span class="aka">check digits ok · open the record</span>`;
  const { entry } = hit;
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
  const status = hit.typed ? null : statusOf(entry.status);
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

/** The preview pane: what the index holds about the selected result. */
export function previewHtml(hit: Hit | undefined): string {
  if (!hit) return "";
  const { entry } = hit;
  const actions = html`<div class="actions"><button class="btn" type="button" data-act="copy">copy lei</button><a class="btn" href="${recordHref(entry.lei)}" data-act="open">open record</a></div>`;
  if (hit.typed) {
    return html`<div class="pane"><span class="label">${entry.lei}</span><p class="note">check digits ok. The index does not list LEIs; the record is fetched from GLEIF when you open it.</p>${actions}</div>`
      .value;
  }
  const status = statusOf(entry.status);
  const others = namesOf(entry).slice(1);
  const country = countryName(entry.country);
  const rows: Html[] = [
    html`<dt>name</dt><dd>${entry.name}</dd>`,
    others.length > 0 ? html`<dt>also</dt><dd>${others.join(" · ")}</dd>` : html``,
    entry.country
      ? html`<dt>country</dt><dd>${entry.country}${country ? ` · ${country}` : ""}</dd>`
      : html``,
    html`<dt>status</dt><dd><span class="st-${status.tone}">${status.label}</span></dd>`,
  ];
  return html`<div class="pane"><span class="label">${entry.lei}</span><dl class="kv">${rows}</dl>${actions}</div>`
    .value;
}

const EXAMPLES: readonly [query: string, about: string][] = [
  ["ericsson", "name"],
  ["h&m", "brand name"],
  ["HWUPKR0MPOU8FGXBT394", "lei"],
  ["HWUPKR0MPOU8FGXBT395", "lei with a typo"],
];

/** The empty state: one line of usage and examples to click. */
export function usageHtml(): string {
  return html`<div class="doc"><p class="lead">type a company name or an lei.</p><h2>examples</h2><div class="examples">${EXAMPLES.map(
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
<h2>SYNOPSIS</h2><p>type a company name or an LEI</p>
<h2>DESCRIPTION</h2><p>Results appear as you type, best match first. Press enter to copy its LEI.</p>
<p>An LEI is a 20-character code defined by ISO 17442. Its last two characters are check digits (ISO 7064 mod 97-10), so a mistyped LEI is caught in your browser before anything is looked up.</p>
<h2>KEYS</h2><dl class="keys">${KEYS.map(([key, does]) => html`<dt>${key}</dt><dd>${does}</dd>`)}</dl>
<h2>DATA</h2><p>Every record comes from GLEIF, the Global Legal Entity Identifier Foundation. The search index is rebuilt daily from GLEIF’s golden copy, published under CC0. An opened record is fetched live from the GLEIF API.</p>${data}
<h2>PRIVACY</h2><p>No account and no cookies. Search runs in your browser. Analytics are cookieless and aggregate, and never see what you type.</p>
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

/** The line under the prompt: how many matches, or what is wrong. */
export function infoLine(state: SearchState): { html: Html; text: string; tone: Tone } {
  const n = state.hits.length;
  const matches =
    n === 1 ? "1 match" : n >= RESULT_LIMIT ? `top ${n} matches` : `${fmt(n)} matches`;
  switch (state.phase) {
    case "empty":
      return { html: html``, text: "", tone: "" };
    case "unconfigured":
      return line("no index is set up for this build, so names cannot be searched", "warn");
    case "loading":
      return line("searching…", "");
    case "short":
      return line("type a little more", "");
    case "bad-lei":
      return line("not a valid lei: the check digits don’t match (iso 7064 mod 97-10)", "bad");
    case "no-match":
      return line(state.message || "no matches", "");
    case "error":
      return {
        html: html`<span class="bad">${state.message}</span><button class="btn" type="button" data-act="${state.reload ? "reload" : "retry"}">${state.reload ? "reload" : "retry"}</button>`,
        text: state.message,
        tone: "bad",
      };
    case "done": {
      if (state.hits[0]?.typed) {
        return {
          html: html`lei · <span class="ok">check digits ok</span>`,
          text: "lei, check digits ok",
          tone: "ok",
        };
      }
      return line(matches, "");
    }
  }
}

function line(text: string, tone: Tone): { html: Html; text: string; tone: Tone } {
  return { html: tone ? html`<span class="${tone}">${text}</span>` : html`${text}`, text, tone };
}

/** What a screen reader hears once the results settle. Null while still searching. */
export function announcement(state: SearchState): string | null {
  switch (state.phase) {
    case "loading":
    case "short":
    case "empty":
      return null;
    case "done":
      return state.hits[0]?.typed ? "valid lei, press enter to copy it" : infoLine(state).text;
    default:
      return infoLine(state).text;
  }
}
