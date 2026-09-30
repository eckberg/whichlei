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
```

`<build>` is unique per build: the golden-copy date and a short hash of the build's
contents, e.g. `20260916-3f9a1c0e`. A file under it never changes.

| File | Cache-Control |
|---|---|
| `index.json` | `no-cache` (revalidate every load; a 304 is ~200 bytes) |
| `<build>/*` | `public, max-age=31536000, immutable` |

Every file is UTF-8 text served as `text/plain` or `application/json`, so Cloudflare
compresses it on the fly. Nothing is precompressed.

A publish uploads the new build directory and the new `index.json` in one Worker
version. It keeps the previous build's directory too (2 × 6,439 files, under the
20,000-file limit), so a page that loaded the old manifest keeps working. A page that
gets a 404 for an index file reloads `index.json` and routes again.

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

- `format`: this version, 1. A reader rejects any other value.
- `asOf`: publish date of the GLEIF golden copy the build used. Shown with every result.
- `entities`: entities reachable through the index.
- `bounds`: the routing table. `bounds[i]` is the first index term of file `i`; the list
  is sorted by UTF-16 code unit (terms are `[a-z0-9]`, so this is byte order). File `i`
  holds every term `t` with `bounds[i] <= t < bounds[i + 1]`.
- `capped`: ascending numbers of the files that hold a single oversized word and were cut
  to their 1,500 most prominent entities.

`route(queryTokens(text), routingTable(manifest), { lastIsPrefix, paused })` gives the
file numbers to fetch; `filePath(manifest, n)` gives the path.

## Index file: `<build>/<n>.txt`

One line per entity, ending in `\n`. Fields are separated by `\t`:

```
lei  prominence  country  status  legal name  [other name ...]
```

| Field | Content |
|---|---|
| `lei` | 20 characters |
| `prominence` | integer: prominence × 10, rounded half up (`Math.round`) |
| `country` | ISO 3166-1 alpha-2 of the legal address |
| `status` | registration status: `I` issued, `L` lapsed, `T` pending transfer, `P` pending archival, `R` retired, `D` duplicate, `A` annulled, `M` merged; lower case when the entity status is INACTIVE |
| `legal name` | as GLEIF has it |
| `other name` | zero or more: trading, alternative-language and transliterated names, deduplicated, none equal to the legal name |

Tabs, carriage returns and line feeds inside names are replaced by a space. The tokeniser
treats all three as whitespace, so matching is unchanged.

Lines are ordered by prominence, highest first, then by LEI. An entity appears in every
file that holds one of its index terms, so the same line can be in two fetched files;
the reader merges by LEI.

Example:

```
549300W9JLPW15XI9W41	23	SE	I	Telefonaktiebolaget LM Ericsson	Ericsson
```

`decodeEntries` parses a file; `toCandidate` tokenises an entry's names for `topK`.

## What the page gets from the GLEIF API instead

Everything else in a record: addresses, registration authority and number, dates,
relationships, ISINs, BICs. It is fetched when a record is opened (DESIGN.md decision 2).
