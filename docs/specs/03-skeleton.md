# 03 · Skeleton on Cloudflare

Status: approved

## Goal
The prototype runs on a real URL. Anyone can open it on a laptop or phone and search the
sample of 2,924 records. Every later slice can be tried the same way.

## Scope
- `apps/web`: a build that assembles `design/prototype` into `dist/`, and an assets-only
  Worker `whichlei-site` on workers.dev.
- `.github/workflows/deploy-site.yml`: run by hand; builds, deploys, then runs the browser
  tests against the deployed URL.
- Browser tests (Playwright) in CI against `wrangler dev`.
- Basic headers: `nosniff`, no referrer.

## Not in scope
- The real index and search page (slices 4–7), whichlei.com (slice 11).
- Self-hosting the font. The prototype loads Red Hat Mono from Google Fonts; slice 7 serves
  it from the site.

## Approach
Workers with static assets: no server code yet, and static requests are free. `wrangler`
deploys with the account ID and API token from repository secrets. The build is a small
Node script doing what `design/prototype/build.py` does, plus doctype, charset and
viewport. pnpm allows install scripts only for `esbuild` and `workerd`, which wrangler needs.

## Unknowns
- Whether the token can deploy and whether the account has a workers.dev subdomain. Found
  out by the first run.

## Done when
- The deploy workflow succeeds and its browser tests pass against the live URL. Link to run.
- Searching "ericsson" on the live URL shows Telefonaktiebolaget LM Ericsson first.
  Screenshot.
- CI runs the browser tests on every pull request.
