# 08 · Lookups and records

Status: approved

## Goal
An LEI, ISIN, BIC or register number typed into the search resolves live through the GLEIF
API. Opening a result shows the full record with its source and date, and copies in one key.

## Scope
- `packages/gleif`: a typed client with no dependencies, for the browser and the Worker
  (slice 9): `fetchRecord`, `fetchIsins`, `findByIsin`, `findByBic`,
  `findByRegisterNumber`, typed errors (not found, rate limited, failed).
- In the search page (slice 7): every identifier reading (`identifierReadings`) runs its
  lookup; the readings with hits are shown, the others are not (DESIGN.md decision 8).
- The record view is the server-rendered record page of slice 9 (`/lei/<code>`), not a view
  in the search page. It gains the names of legal form and registration authority codes (from
  the published index's `codes.json`) and a copy json button. Parents stay linked LEIs, with no
  extra request for their names.
- Errors: not found, rate limited, offline. Each says what happened and what to do.

## Not in scope
- Server-rendered record pages (slice 9). Caching beyond the browser's.

## Approach
One request per record: `include=direct-parent,ultimate-parent` brings the parent LEIs and
reporting exceptions. Parents are shown as linked LEIs: no request for their names.
GLEIF stores every BIC with 11 characters, so an 8-character BIC is looked up as `…XXX`.
Register numbers match whole words, so exact matches go first. Lookups fire on a typing
pause, not per keystroke: GLEIF limits requests per IP.

## Lookups in the page
`apps/web/src/lookups/`, no DOM, tested with a fake `fetch`. The readings of an input are
`identifierReadings` plus a register number (at least 5 characters of letters, digits, spaces
and `. - /`, at least 4 digits, digits at least half of the letters and digits, and not the
shape of an LEI or ISIN: "AST Bond Portfolio 2021" is a name). Each reading fires its lookup
after 350 ms without a key, once per distinct reading, cached for the page session; a request for
a reading no longer in the box is aborted. Hits are rows above the names, tagged `isin`, `bic`
or `reg.no`. An LEI row gains its legal name and status when `fetchRecord` answers, and goes
("no such LEI at GLEIF") when GLEIF says not found. A 429 is "GLEIF is busy, try again in a
minute", anything else "could not reach GLEIF", each with a retry; the names never wait.

## Record page
The Worker reads `index.json` and `<build>/codes.json` from `INDEX_ORIGIN` (a wrangler var,
the value deploy-site.yml builds with), alongside the GLEIF call, and keeps them in a module
variable for 5 minutes and in the Cache API. Any failure leaves the codes as they were; a page
rendered without names that should have been there is kept 5 minutes, not a day.

## Unknowns
- The rate limit under real use (about 60 requests a minute per IP). The e2e tests count
  requests per typed identifier; the target is at most one per reading.

## Done when
- Client tests replay 15 recorded GLEIF responses, with no network in CI.
- Browser tests with a mocked GLEIF: each identifier type finds its entity, each error
  shows its message, and typing an LEI sends one request.
- A screenshot of a live record on workers.dev.

## Lands as
Two pull requests: the client, then the page work after slice 7.
