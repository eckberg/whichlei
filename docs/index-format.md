# Index format

Format version 1. The contract between the indexer (slice 5), publishing (slice 6) and the
search page (slice 7). The code is `packages/core/src/format.ts` and `route.ts`; why it looks
like this is in [specs/04-index-format.md](specs/04-index-format.md).

## Files

```
index.json              the manifest; the only file that changes in place
<build>/0.txt           index file 0
<build>/1.txt           ...
<build>/<n-1>.txt
<build>/codes.json      names for legal form and registration authority codes
```

`<build>` is unique per build: `YYYYMMDD-<hex>`, the golden-copy date (the manifest's
`asOf` without dashes) and 8 to 64 lowercase hex digits of a hash of the build's contents,
e.g. `20260916-3f9a1c0e`. A file under it never changes.

| File | Cache-Control |
|---|---|
| `index.json` | `no-cache` (revalidate every load; a 304 is ~200 bytes) |
| `<build>/*` | `public, max-age=31536000, immutable` |

Every file is UTF-8 text served as `text/plain` or `application/json`, so Cloudflare
compresses it on the fly. Nothing is precompressed.

The search page is on another origin (its build setting `INDEX_ORIGIN`), so every response,
404s included, carries `Access-Control-Allow-Origin: *`. The page needs nothing else from the
index host: only GET, no custom request headers, no cookies.

A publish uploads the new build directory and the new `index.json` in one Worker
version. It keeps the previous build's directory too: 2 × (6,438 index files + `codes.json`
+ `report.json`) + 1 manifest = 12,881 files, under the 20,000-file limit. So a page that
loaded the old manifest keeps working. The publish asserts the count stays under the limit.

Every response carries `Access-Control-Allow-Origin: *` and `X-Content-Type-Options:
nosniff`. They come from the `_headers` file `index assemble` writes, which also sets the
`Cache-Control` above: one rule for `index.json` and one for each of the two builds.

## Reader rules

- Parse `index.json` with `parseManifest`. On `UnsupportedFormatError` the page's code is
  older or newer than the index: reload the page once to get matching code, then show an
  error. Any other `IndexFormatError` is an error to show.
- Cache fetched and parsed index files by their full path, `<build>/<n>.txt`
  (`filePath`), never by number alone, so files of two builds never mix.
- After a 404 for an index file, reload `index.json` once and route again. A second 404
  is an error to show.

## Manifest: `index.json`

```json
{
  "format": 1,
  "build": "20260916-3f9a1c0e",
  "asOf": "2026-09-16",
  "entities": 3317220,
  "bounds": ["00", "009", "0100402", "..."],
  "capped": [17, 18, "..."]
}
```

- `format`: this version, 1.
- `build`: as above.
- `asOf`: publish date of the GLEIF golden copy the build used, `YYYY-MM-DD`. Shown with
  every result.
- `entities`: entities reachable through the index, a non-negative integer.
- `bounds`: the routing table, not empty. `bounds[i]` is the first index term of file
  `i`, matching `[a-z0-9]+`, strictly ascending by UTF-16 code unit (for these characters,
  byte order). File `i` holds every term `t` with `bounds[i] <= t < bounds[i + 1]`; a
  term below `bounds[0]` goes to file 0.
- `capped`: the files that hold a single oversized word and were cut to their 1,500 most
  prominent entities. Ascending, unique, each in `[0, bounds.length)`.

`parseManifest` checks all of the above and drops unknown fields.

To route: `route(queryTokens(text), routingTable(manifest), { lastIsPrefix:
lastIsPrefix(text), paused })`. `lastIsPrefix(text)` is false once the text ends in
whitespace (the tokeniser's whitespace set), because the last word is then finished.
`paused` is true when the debounce has fired. The result is file numbers;
`filePath(manifest, n)` gives each path.

## Index file: `<build>/<n>.txt`

One line per entity. Fields are separated by `\t`:

```
lei  prominence  country  status  legal name  [other name ...]
```

| Field | Content |
|---|---|
| `lei` | 20 characters, `[0-9A-Z]` |
| `prominence` | integer, `-?[0-9]+`: prominence × 10, rounded with `Math.round` |
| `country` | ISO 3166-1 alpha-2 of the legal address, `[A-Z]{2}` |
| `status` | registration status: `I` issued, `L` lapsed, `T` pending transfer, `P` pending archival, `R` retired, `D` duplicate, `A` annulled, `M` merged; lower case when the entity status is INACTIVE |
| `legal name` | as GLEIF has it; not empty |
| `other name` | zero or more: trading, alternative-language and transliterated names; none empty, none repeated, none equal to the legal name |

`Math.round` rounds halves toward +∞: 0.25 → `3` (0.3), −0.25 → `-2` (−0.2), −0.26 →
`-3` (−0.3), −0.04 → `0`. A reader divides by 10.

Lines end in `\n`, the last one too. There are no empty lines, and a `\r` anywhere is an
error. An empty file is valid and holds no entries. Tabs, carriage returns and line feeds
inside names are replaced by a space before writing; the tokeniser treats all three as
whitespace, so matching is unchanged. `encodeEntries` throws `IndexFormatError` on an
entry that breaks these rules, and `decodeEntries` on a file that does.

Lines are ordered by full-precision prominence, highest first, then by LEI. The 1,500-entry
cap also uses full precision. The stored tenths are for scoring only, so two lines with
the same stored prominence need not be in LEI order.

An entity appears in every file that holds one of its index terms, so the same line can be
in two fetched files; the reader merges by LEI.

Example:

```
549300W9JLPW15XI9W41	23	SE	I	Telefonaktiebolaget LM Ericsson	Ericsson
```

`decodeEntries` parses a file; `toCandidate` tokenises an entry's names for `topK`.

## Code names: `<build>/codes.json`

Names for the codes a record carries, so a page shows "Aktiebolag" and "Bolagsverket", not
`XJHM` and `RA000544`. Compact JSON, keys in order, part of the build's content hash:

```json
{
  "elf": { "2HBR": "Gesellschaft mit beschränkter Haftung", "XJHM": "Aktiebolag" },
  "ra": { "RA000544": "Bolagsverket", "RA000585": "Companies House" }
}
```

- `elf`: ISO 20275 entity legal form code to the form's name in its own language (the local
  name of the code's first row in GLEIF's list; else the transliterated name; else the
  abbreviation). Codes with no name are left out.
- `ra`: registration authority code to the name of the organisation that keeps the
  register (its local name; else its international name; else the register's name).
  Codes with no name are left out. Absent when the build had no registration authorities
  list (a local input directory without `ra-list.csv`).

A code that is missing from the file is shown as the code.

The record page Worker reads it: `index.json` for the current `build`, then
`<build>/codes.json`, each cached for a few minutes (a Worker variable and the Cache API), and
shows the codes if either read fails (`apps/web/src/codes.ts`).

## Report: `<build>/report.json`

Added by publishing (slice 6), not by the indexer. It is the indexer's `build.json` plus what
`index checks` measured over the built files, and it is part of the build's directory so the
next publish can compare against it (`apps/index/checks.json`): entities, files and gzip
size must stay within 3%, 5% and 10% of the live build's, and the evaluation objective may
fall at most 0.01 below its. Fixed absolute bounds and a floor for the objective always
apply too, and are all there is on a first publish. A manual run can skip the relative
bounds for that run (`accept-change`). Pages do not read it.

```json
{
  "build": "20260916-3f9a1c0e",
  "asOf": "2026-09-16",
  "records": 3431742,
  "entities": 3317220,
  "files": 6438,
  "gzipBytes": 220600000,
  "reachability": 0.9666,
  "objective": { "test": 0.6515, "all": 0.657 },
  "...": "the rest of build.json: capped, terms, postings, bytes, nowYear, stats, seconds, peakRssMb"
}
```

- `records`: rows in the level 1 golden copy. `entities`: reachable through the index.
  `reachability` is their ratio.
- `files`: index files, `<build>/0.txt` and up. `bytes`: their size; `gzipBytes`: the same
  with each file gzipped at level 6, near what the CDN sends.
- `objective`: the evaluation objective over the built files on the held-out half (`test`)
  and on all queries (`all`), from `indexer check --eval`.

A build published before this file existed has none; the next publish then uses the
absolute bounds instead of bounds relative to the live build.

## The index directory the indexer writes

```
index.json  <build>/…      the index, as above: what slice 6 publishes
build.json                 the build's own report (records, reachable entities, seconds, peak memory)
prominence.tsv             only with `build --dump-prominence`: LEI, full-precision prominence,
                           registration age. Used by `check --reference`
```

`build.json` and `prominence.tsv` are not part of the index and are never published as they
are. `index checks` writes `measured.json` next to them: whether the build passed, and the
report to publish as `<build>/report.json`. `index assemble` refuses a build without a pass.

## What the page gets from the GLEIF API instead

Everything else in a record: addresses, registration authority and number, dates,
relationships, ISINs, BICs. It is fetched when a record is opened (DESIGN.md decision 2).
