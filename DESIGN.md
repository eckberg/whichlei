# whichlei design

This document records the product and technical decisions behind whichlei. When
code and this document disagree, fix one of them in the same pull request.

## 1. What it is

A single-purpose LEI lookup. Type anything that identifies a legal entity — a name, an LEI,
an ISIN, a BIC, a national register number — and get the LEI while you type. Copy it and
leave.

Audience: people who look up LEIs as one step in other work — compliance, onboarding, fund
administration, finance operations, developers handling reference data. They know what an
LEI is. They need it correct, fast and copyable.

### Priorities

When these conflict, the higher one wins.

1. **Correct.** LEIs end up in regulatory filings. Every record traces to GLEIF and is dated.
2. **Instant.** Results while typing. After the first fetch, typing never waits on the network.
3. **Frictionless.** Focused input, keyboard throughout, one action to copy.
4. **Plain.** No banner, modal, sign-up or upsell.

### Non-goals

These are deliberate. Requests that cross them are closed with a link here.

- No monetization: no ads, no paid tier, no sponsored results.
- No accounts and no server-side user state.
- No cookies and no consent banner. Analytics are cookieless and aggregate; see decision 12.
- No portfolio features: watchlists, monitoring, alerts, comparisons.
- No infrastructure with a fixed monthly cost.

## 2. Product decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | The search index is **static files on a CDN**. No search server | 6,438 files, 223 MB. Fits a free static host (20,000-file limit), where static requests are free and unlimited. |
| 2 | An opened record is **fetched live** from the GLEIF API | The API is too slow for typeahead (~0.5 s median, per-IP rate limit) but right for one deliberate lookup, and always current. |
| 3 | The index is **rebuilt nightly** from GLEIF's daily files | The only compute in the system. Runs on free CI. |
| 4 | Ranking adds a **prominence** score to **name match**, with weights fitted on an evaluation set | Name match alone ranked Telefonaktiebolaget LM Ericsson 335th for "ericsson". Fitted, the mean reciprocal rank on held-out queries goes from .23 to .65. See §4. |
| 5 | **Trading, alternative-language and transliterated names** are searchable, not only legal names | People type the name they know. +.05 on the evaluation set for +28 MB of index. |
| 6 | A query fetches **at most two files**, one per word, fixed once the word has three characters | Typing a whole name fetches at most 462 KB, even if every keystroke fetches. Fetching every word's file scored .004 higher for ~9× the bytes. |
| 7 | **No boost for governments or popularity** | Both only looked good because the evaluation's well-known entities came from Wikidata. A government boost put a government first for 57 of 1,335 company queries. |
| 8 | Input type is resolved by **evidence**, not shape | "ERICSSON" is also a valid BIC. Run the candidate lookups and show the reading that has hits. |
| 9 | LEI check digits are **validated in the browser** | ISO 7064 mod 97-10 catches a mistyped LEI before any request is sent. |
| 10 | Every record shows its **source and date** | Correctness has to be checkable, not just claimed. |
| 11 | A **terminal-style** interface: one monospace face, a prompt, reverse-video selection, and the keys for the current view in the footer. Light or dark follows the system | LEIs, ISINs and BICs are fixed-width codes, and the audience works from the keyboard. The reader's own theme setting wins. Prototype: [design/prototype](design/prototype/). |
| 12 | Analytics: **Fathom**, cookieless and aggregate | Usage numbers without cookies or a consent banner. It sets no identifiers and never receives search input. |
| 13 | Name: **whichlei** | It names the question it answers: which LEI does this entity have. Short, reads one way, and clear of existing LEI tools. |
| 14 | **Enter copies the LEI** of the selected result; → opens the full record | Copying the LEI is the job. Opening the record is the exception. |
| 15 | The index is its **own Worker with static assets**, published by a scheduled workflow after automatic checks. The site deploys by hand | Static requests are free and unlimited. A publish swaps every file at once and can be rolled back, and new data never redeploys the site. |
| 16 | **TypeScript throughout**. Python stays in `research/` as the reference | One language for the indexer and the browser means one tokeniser. The reference checks it. |

## 3. Architecture

Two paths, split by latency.

- **Typeahead** reads the static index. Names are split into words, and entities are
  grouped into files by word prefix. A file closes before it exceeds 1,500 entries, so
  96.7% of LEIs are reachable; the rest sit under words too common to route on, such as
  "limited". An 18 KB routing table maps a prefix to its file. Scoring runs in the browser.
- **Record view** fetches one record from the GLEIF API when the user opens it.

| Measured on the 2026-09-16 golden copy | |
|---|---|
| Records | 3,431,742 |
| Reachable through the index | 96.7% |
| Index files | 6,438 |
| Index size, gzipped | 223 MB |
| File size, gzipped | median ~37 KB |
| Fetched while typing, debounce fires on every key | median 147 KB, p90 271 KB, max 462 KB |
| Fetched while typing, debounce fires on the last key | median 64 KB, p90 105 KB, max 228 KB |
| Scoring, slowest keystroke per query (JavaScript, idle server) | median 20 ms, p90 43 ms, max 476 ms |
| Routing table, gzipped | 18 KB |
| GLEIF API latency | median ~0.5 s |

Phones are several times slower than the server used for scoring times. The slowest
keystroke needs work before it feels instant on a phone.

Two packings were rejected. Uniform 3-character buckets give 25,867 files, over the
20,000-file limit. Closing files by word count rather than entries left 65% of LEIs in no
file at all.

## 4. Ranking

Each candidate's score is its prominence plus its best name match.

- **Prominence** is computed at build time, from GLEIF data only: registration and entity
  status, consolidated subsidiaries, top-parent status, BIC, ISINs, registration age, name
  length. It orders each file and decides what survives a file's cap.
- **Match** is computed in the browser: words matched, exact or fuzzy (one edit), share of
  the name's words matched, exact name.
- 19 weights, fitted on half of the evaluation set. The other half is only used to report.

The evaluation set covers well-known entities by common name and brand (from Wikidata),
mid-tier entities by their first words, obscure entities by full legal name, and typos.
Held-out half, 1,613 queries, share with the right entity first:

| | Before | Now |
|---|---|---|
| Well-known entities (companies only) | .26 | .56 (.63) |
| Brand names and aliases | .28 | .85 |
| Mid-tier entities | .24 | .43 |
| Full legal name | .50 | .98 |
| Typo after the third character | .04 | .51 |

On 100 of the well-known queries, GLEIF's own autocomplete puts the right entity first 30%
of the time; this ranking 56%. The held-out half was scored more than once while fixing
bugs, so these numbers may be slightly optimistic.

Known gaps: acronyms ("seb" finds SEB SA, not the bank), short queries of two to four
letters ("bp", "sas"), ~92k names with no Latin-script form, typos in the first three or
four characters, previous names.

Method, code and full results: [`research/ranking/`](research/ranking/).

## 5. Data

GLEIF publishes under CC0, daily: the level 1 golden copy (entities, ~500 MB zipped), the
level 2 golden copy (relationships, ~23 MB zipped), and ISIN and BIC mapping files. The
build uses nothing else. Wikidata is used only to build the evaluation set.

## 6. Open questions

- **Record pages.** 3.4M pages exceed the static-asset file limit, so they are rendered by a
  Worker on request and cached. How long to cache, and what a crawler sees, is slice 9.
- **Corporate hierarchy** in the first release, or later?
- **Funds** rank slightly above other entities (fitted weight +0.32, no measurable effect).
  Keep, or set to zero?
