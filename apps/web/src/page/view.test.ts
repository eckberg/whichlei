import type { Entry } from "@whichlei/core";
import { describe, expect, it } from "vitest";
import type { Hit } from "../search/entry.ts";
import { RESULT_LIMIT, type SearchState } from "../search/search.ts";
import {
  aboutHtml,
  announcement,
  infoLine,
  keysHtml,
  markHtml,
  metaText,
  previewHtml,
  rowsHtml,
  usageHtml,
} from "./view.ts";

const entry = (over: Partial<Entry> = {}): Entry => ({
  lei: "549300W9JLPW15XIFM52",
  name: "Telefonaktiebolaget LM Ericsson",
  otherNames: ["Ericsson", "LM Ericsson"],
  country: "SE",
  status: "I",
  prominence: 20,
  ...over,
});

const state = (over: Partial<SearchState> = {}): SearchState => ({
  text: "ericsson",
  phase: "done",
  hits: [{ entry: entry() }],
  tokens: ["ericsson"],
  message: "",
  reload: false,
  index: { asOf: "2026-09-16", entities: 3317220 },
  ...over,
});

describe("markHtml", () => {
  it("marks ranges and escapes everything around them", () => {
    expect(markHtml("A&B <Bank>", [[2, 3]]).value).toBe("A&amp;<mark>B</mark> &lt;Bank&gt;");
    expect(markHtml("plain", []).value).toBe("plain");
  });
});

describe("rowsHtml", () => {
  it("renders one option per hit, the selected one marked", () => {
    const hits: Hit[] = [{ entry: entry() }, { entry: entry({ lei: `${"B".repeat(18)}01` }) }];
    const out = rowsHtml(hits, ["ericsson"], 1);
    expect(out.match(/role="option"/g)).toHaveLength(2);
    expect(out).toContain(
      'id="opt-0" data-k="0" aria-setsize="2" aria-posinset="1" aria-selected="false"',
    );
    expect(out).toContain(
      'id="opt-1" data-k="1" aria-setsize="2" aria-posinset="2" aria-selected="true"',
    );
    expect(out).toContain('<span class="ptr" aria-hidden="true">&gt;</span>');
    expect(out).toContain("Telefonaktiebolaget LM <mark>Ericsson</mark>");
    expect(out).toContain('<span class="st st-active">active</span>');
  });

  it("shows the other name that matched, when the legal name does not", () => {
    const hit: Hit = { entry: entry({ name: "Telefonaktiebolaget LM", otherNames: ["Ericsson"] }) };
    expect(rowsHtml([hit], ["ericsson"], 0)).toContain(
      '<span class="aka">(<mark>Ericsson</mark>)</span>',
    );
  });

  it("never lets an index value become markup", () => {
    const hostile = entry({ name: '<img src=x onerror="boom()">', country: "<b>", otherNames: [] });
    const out = rowsHtml([{ entry: hostile }], ["img"], 0) + previewHtml({ entry: hostile });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img");
  });

  it("makes the row of a typed LEI say what opening does", () => {
    const out = rowsHtml([{ entry: entry({ name: "" }), typed: true }], [], 0);
    expect(out).toContain("open the record");
    expect(out).not.toContain("st-active");
  });
});

describe("previewHtml", () => {
  it("shows the index's data and links to the record", () => {
    const out = previewHtml({ entry: entry() });
    expect(out).toContain('<span class="label">549300W9JLPW15XIFM52</span>');
    expect(out).toContain("<dt>name</dt><dd>Telefonaktiebolaget LM Ericsson</dd>");
    expect(out).toContain("<dt>also</dt><dd>Ericsson · LM Ericsson</dd>");
    expect(out).toContain("<dt>country</dt><dd>SE");
    expect(out).toContain('<span class="st-active">active</span>');
    expect(out).toContain('href="/lei/549300W9JLPW15XIFM52"');
    expect(out).toContain('data-act="copy"');
  });

  it("leaves out what the entry lacks", () => {
    const out = previewHtml({ entry: entry({ otherNames: [], country: "" }) });
    expect(out).not.toContain("<dt>also</dt>");
    expect(out).not.toContain("<dt>country</dt>");
  });

  it("is empty with no hit", () => {
    expect(previewHtml(undefined)).toBe("");
  });
});

describe("infoLine", () => {
  it("counts matches", () => {
    expect(infoLine(state()).text).toBe("1 match");
    const many = Array.from({ length: 7 }, () => ({ entry: entry() }));
    expect(infoLine(state({ hits: many })).text).toBe("7 matches");
  });

  it("says the list is cut at the limit", () => {
    const hits = Array.from({ length: RESULT_LIMIT }, () => ({ entry: entry() }));
    expect(infoLine(state({ hits })).text).toBe(`top ${RESULT_LIMIT} matches`);
  });

  it("names the check digits, good and bad", () => {
    const bad = infoLine(state({ phase: "bad-lei", hits: [] }));
    expect(bad.tone).toBe("bad");
    expect(bad.text).toContain("check digits");
    const good = infoLine(state({ hits: [{ entry: entry(), typed: true }] }));
    expect(good.html.value).toContain("check digits ok");
  });

  it("offers a retry on an error, and says when no index is set up", () => {
    const error = infoLine(
      state({ phase: "error", hits: [], message: "could not reach the index" }),
    );
    expect(error.html.value).toContain('data-act="retry"');
    const old = infoLine(
      state({
        phase: "error",
        hits: [],
        message: "this page is out of date: reload it",
        reload: true,
      }),
    );
    expect(old.html.value).toContain('data-act="reload"');
    expect(infoLine(state({ phase: "unconfigured", hits: [] })).tone).toBe("warn");
  });

  it("says nothing on an empty box, and what it knows on no match", () => {
    expect(infoLine(state({ phase: "empty", hits: [] })).text).toBe("");
    expect(infoLine(state({ phase: "no-match", hits: [] })).text).toBe("no matches");
    expect(
      infoLine(
        state({ phase: "no-match", hits: [], message: "looks like an lei: 14/20 characters" }),
      ).text,
    ).toBe("looks like an lei: 14/20 characters");
  });
});

describe("announcement", () => {
  it("waits while the search is unsettled", () => {
    expect(announcement(state({ phase: "loading" }))).toBeNull();
    expect(announcement(state({ phase: "short", hits: [] }))).toBeNull();
    expect(announcement(state({ phase: "empty", hits: [] }))).toBeNull();
  });

  it("says the count, or what went wrong", () => {
    expect(announcement(state())).toBe("1 match");
    expect(announcement(state({ phase: "no-match", hits: [] }))).toBe("no matches");
    expect(announcement(state({ phase: "bad-lei", hits: [] }))).toContain("not a valid lei");
  });
});

describe("the static screens", () => {
  it("lists the keys of each view", () => {
    expect(keysHtml("search", true)).toContain("<kbd>⏎</kbd>copy lei");
    expect(keysHtml("search", false)).toContain("<kbd>?</kbd>about");
    expect(keysHtml("about", false)).toContain("<kbd>q</kbd>quit");
  });

  it("shows the index it reads", () => {
    expect(metaText(state().index)).toBe("index: 3,317,220 entities · gleif 2026-09-16");
    expect(metaText(null)).toBe("");
    expect(aboutHtml(state().index)).toContain("3,317,220 entities");
    expect(aboutHtml(null)).toContain("WHICHLEI(1)");
  });

  it("offers examples that work without a lookup service", () => {
    const out = usageHtml();
    expect(out).toContain('data-q="ericsson"');
    expect(out).not.toMatch(/isin|bic|register/i);
  });

  it("has no inline style or script", () => {
    for (const out of [usageHtml(), aboutHtml(null), previewHtml({ entry: entry() })]) {
      expect(out).not.toMatch(/\sstyle=|<script|\son[a-z]+=/i);
    }
  });
});
