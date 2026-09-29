# 01 · Workspace

Status: approved

## Goal
Anyone can clone the repository and run lint, type checks and tests with one command each.
CI runs the same on every pull request, so no later slice lands unchecked.

## Scope
- pnpm workspace; Node and pnpm versions pinned.
- TypeScript in strict mode, Biome for lint and format, Vitest for tests.
- `packages/core` with its first real code: LEI check digits (ISO 7064 mod 97-10), tested
  against every distinct LEI in `research/ranking/eval/*.tsv`, and a copy of each with one
  character changed.
- `.github/workflows/ci.yml` on pull requests and pushes to `main`: install from the
  lockfile, lint, typecheck, test.
- `.editorconfig`, and a Commands section in CLAUDE.md.

## Not in scope
- The web app (slice 3), the indexer (slice 5), any deploy.
- `research/` stays Python and outside CI.

## Approach
Layout `packages/*` for libraries and `apps/*` for deployables. Biome replaces ESLint and
Prettier with one tool and one config. Vitest runs TypeScript without a build step. Versions
are the current stable releases on the day, pinned: Node 26 by the owner's choice (it enters
LTS in October 2026), tool versions once in the pnpm catalog, actions by commit.

## Unknowns
None that need a spike.

## Done when
- `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` passes
  locally. Output pasted in the pull request.
- The same passes in GitHub Actions on the pull request. Link to the run.
- A test broken on purpose fails CI once, then is reverted. Link to that run.

## Lands as
One pull request from a branch. The owner merges.
