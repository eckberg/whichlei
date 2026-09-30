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
- The record view: names, statuses, addresses, register, legal form, BICs, ISINs (paged),
  parents with names, source link and golden copy date, copy LEI and copy JSON.
- Errors: not found, rate limited, offline. Each says what happened and what to do.

## Not in scope
- Server-rendered record pages (slice 9). Caching beyond the browser's.

## Approach
One request per record: `include=direct-parent,ultimate-parent` brings the parent LEIs and
reporting exceptions. Parent names come from the index when loaded, else one more request.
GLEIF stores every BIC with 11 characters, so an 8-character BIC is looked up as `…XXX`.
Register numbers match whole words, so exact matches go first. Lookups fire on a typing
pause, not per keystroke: GLEIF limits requests per IP.

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
