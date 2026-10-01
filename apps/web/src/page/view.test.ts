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
  lei: null,
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

  it("escapes HTML-special characters inside the marked part of a name", () => {
    const att: Hit = { entry: entry({ name: "AT&T <b>Inc", otherNames: [] }) };
    const out = rowsHtml([att], ["att"], 0);
    expect(out).toContain("<mark>AT&amp;T</mark>");
    expect(out).toContain("&lt;b&gt;Inc");
    expect(out).not.toContain("<b>");
    // The mark itself holds the special characters.
    const tag: Hit = { entry: entry({ name: "<b>x", otherNames: [] }) };
    const marked = rowsHtml([tag], ["b"], 0);
    expect(marked).toContain("&lt;<mark>b</mark>&gt;x");
    expect(marked).not.toContain("<b>");
  });

  it("makes the row of a typed LEI say what opening does", () => {
    const out = rowsHtml([{ entry: entry({ name: "" }), typed: true }], [], 0);
    expect(out).toContain("open the record");
    expect(out).not.toContain("st-active");
  });
});

describe("lookup rows", () => {
  const found: Hit = {
    entry: entry({ name: "Apple Inc.", country: "US", otherNames: [] }),
    via: "isin",
    status: { label: "active", tone: "active" },
  };
  const confirmed: Hit = {
    entry: found.entry,
    status: { label: "active", tone: "active" },
    typed: true,
  };

  it("tags a row with the reading, and marks nothing in its name", () => {
    const out = rowsHtml([found], ["apple"], 0);
    expect(out).toContain('<span class="aka via">isin</span> Apple Inc.');
    expect(out).not.toContain("<mark>");
    expect(out).toContain('<span class="st st-active">active</span>');
  });

  it("shows GLEIF's own words for the state, not the index's letter", () => {
    const lapsed: Hit = { ...found, status: { label: "lapsed", tone: "lapsed" } };
    expect(rowsHtml([lapsed], [], 0)).toContain('<span class="st st-lapsed">lapsed</span>');
  });

  it("shows the legal name of an LEI that GLEIF has confirmed, with no tag", () => {
    const out = rowsHtml([confirmed], [], 0);
    expect(out).toContain("Apple Inc.");
    expect(out).not.toContain("open the record");
    expect(out).not.toContain("via");
  });

  it("escapes the tag and the name", () => {
    const hostile: Hit = { ...found, via: "<i>", entry: entry({ name: "<b>x" }) };
    const out = rowsHtml([hostile], [], 0);
    expect(out).not.toContain("<i>");
    expect(out).not.toContain("<b>");
  });

  it("says in the preview how the entity was found", () => {
    expect(previewHtml(found)).toContain("<dt>found by</dt><dd>isin, at GLEIF</dd>");
    expect(previewHtml(confirmed)).toContain("found at GLEIF");
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
    const bad = infoLine(state({ phase: "bad-lei", hits: [], lei: "invalid" }));
    expect(bad.tone).toBe("bad");
    expect(bad.text).toContain("check digits");
    const good = infoLine(state({ hits: [{ entry: entry(), typed: true }], lei: "valid" }));
    expect(good.html.value).toContain("check digits ok");
    expect(good.text).toBe("lei, check digits ok");
  });

  it("counts the names beside the row of a valid LEI, and notes bad check digits as a line", () => {
    const row = { entry: entry({ lei: `${"H".repeat(18)}01` }), typed: true } as const;
    const withNames = infoLine(state({ hits: [row, { entry: entry() }], lei: "valid" }));
    expect(withNames.text).toBe("lei, check digits ok · 1 match");
    const invalid = infoLine(state({ hits: [{ entry: entry() }], lei: "invalid" }));
    expect(invalid.text).toBe("1 match · not a valid lei: the check digits don’t match");
    expect(invalid.html.value).toContain('<span class="warn">');
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

describe("infoLine with lookups", () => {
  const none = { leiMissing: false, found: [], pending: false, failure: null } as const;

  it("counts the hits of each reading apart from the matches by name", () => {
    const rows: Hit[] = [
      { entry: entry(), via: "isin" },
      { entry: entry({ lei: "B".repeat(20) }) },
    ];
    const out = infoLine(state({ hits: rows }), {
      ...none,
      found: [{ kind: "isin", shown: 1, total: 1 }],
    });
    expect(out.text).toBe("isin · 1 hit · 1 match");
  });

  it("says when GLEIF has more than is shown", () => {
    const out = infoLine(state(), { ...none, found: [{ kind: "reg.no", shown: 10, total: 37 }] });
    expect(out.text).toContain("reg.no · top 10 of 37");
  });

  it("says no such LEI at GLEIF instead of the check digits being fine", () => {
    const out = infoLine(state({ lei: "valid", phase: "no-match", hits: [] }), {
      ...none,
      leiMissing: true,
    });
    expect(out.text).toBe("no such LEI at GLEIF");
    const withNames = infoLine(state({ lei: "valid" }), { ...none, leiMissing: true });
    expect(withNames.text).toBe("no such LEI at GLEIF · 1 match");
    expect(withNames.text).not.toContain("check digits ok");
  });

  it.each([
    ["busy", "GLEIF is busy, try again in a minute"],
    ["offline", "could not reach GLEIF"],
  ] as const)("says %s, with a retry that is not the index's", (failure, text) => {
    const out = infoLine(state({ phase: "no-match", hits: [] }), { ...none, failure });
    expect(out.text).toBe(text);
    expect(out.html.value).toContain('data-act="retry-lookup"');
    expect(out.html.value).not.toContain('data-act="retry"');
  });

  it("keeps the lookups' news and retry beside an error of the index", () => {
    const error = state({ phase: "error", hits: [], message: "could not reach the index" });
    const out = infoLine(error, {
      ...none,
      found: [{ kind: "isin", shown: 1, total: 1 }],
      failure: "busy",
    });
    expect(out.text).toBe(
      "could not reach the index · isin · 1 hit · GLEIF is busy, try again in a minute",
    );
    expect(out.html.value).toContain('data-act="retry"');
    expect(out.html.value).toContain('data-act="retry-lookup"');
    expect(out.tone).toBe("bad");
  });

  it("keeps the names' count beside a failure", () => {
    const out = infoLine(state(), { ...none, failure: "offline" });
    expect(out.text).toBe("1 match · could not reach GLEIF");
  });

  it("says a lookup is at work instead of 'no matches'", () => {
    const out = infoLine(state({ phase: "no-match", hits: [] }), { ...none, pending: true });
    expect(out.text).toBe("looking up at GLEIF…");
    expect(infoLine(state({ phase: "short", hits: [] }), { ...none, pending: true }).text).toBe(
      "looking up at GLEIF…",
    );
    expect(infoLine(state({ phase: "no-match", hits: [] })).text).toBe("no matches");
  });

  it("announces what the lookups found or could not do", () => {
    expect(announcement(state(), { ...none, failure: "busy" })).toBe(
      "1 match · GLEIF is busy, try again in a minute",
    );
    expect(
      announcement(state({ phase: "no-match", hits: [] }), { ...none, leiMissing: true }),
    ).toBe("no such LEI at GLEIF");
    expect(
      announcement(state({ phase: "short", hits: [] }), { ...none, pending: true }),
    ).toBeNull();
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

  it("offers an example of every kind of input", () => {
    const out = usageHtml();
    for (const example of ["ericsson", "US0378331005", "TEERSESSXXX", "556016-0680"]) {
      expect(out).toContain(`data-q="${example}"`);
    }
    expect(out).toMatch(/isin/);
    expect(out).toMatch(/bic/);
    expect(out).toMatch(/swedish register number/);
  });

  it("says in the about page that identifiers go to GLEIF, and nothing else does", () => {
    const out = aboutHtml(null);
    expect(out).toContain("sent to the GLEIF API");
    expect(out).toContain("Nothing else you type goes anywhere");
  });

  it("has no inline style or script", () => {
    for (const out of [usageHtml(), aboutHtml(null), previewHtml({ entry: entry() })]) {
      expect(out).not.toMatch(/\sstyle=|<script|\son[a-z]+=/i);
    }
  });
});
