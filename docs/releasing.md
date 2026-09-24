# Releasing Project Vault

Releases are cut from `main` by publishing a GitHub Release on a `vMAJOR.MINOR.PATCH` tag.
Publishing the release triggers `container-publish.yml` (GHCR images) and `fly-deploy.yml`
(the public demo).

The version number lives **only in the tag**. Never bump any `package.json` version — they stay
at `0.0.1` on purpose, and the release identity is injected as the `RELEASE_VERSION` build
argument. The release-identity section of [docs/runbook.md](runbook.md) explains why.

## 0. Decide the version

- **Patch** — fixes only: no migration, no environment-variable change, no behavior change.
- **Minor** — new features, additive migrations, new optional environment variables, or
  hardening that ships with a documented migration path.
- **Major** — a removed or renamed public API route or response contract, a new *required*
  environment variable, a destructive migration, or any change an operator cannot upgrade
  through with only the release notes in hand.

Whatever the number, the release notes must carry an "Upgrade notes" section. That, not the
digit, is what protects operators.

## 1. Pre-flight (on a clean `main` checkout)

```bash
git fetch origin && git checkout main && git pull --ff-only
git log --format='%h %s' v<prev>..HEAD
git diff --stat v<prev>..HEAD -- packages/db/src/migrations .env.example docker-compose*.yml
pnpm check-migration-compatibility          # static scan of every migration
pnpm check-env-example                      # environment schema vs .env.example
pnpm check-extension-api-version-skew       # contract bump present if the surface changed
pnpm check-extension-api-contract-changelog # changelog entry plus contract hash
make ci                                     # or confirm the last main CI run is green
```

## 2. Documentation

- [CHANGELOG.md](../CHANGELOG.md): move `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`; fill in
  Upgrade notes (migrations, environment variables, behavior changes) and the Added / Changed /
  Fixed / Security sections; update the compare links at the bottom.
- [README.md](../README.md): update the features table and roadmap for anything newly shipped,
  and re-check the secret count and environment-variable lists.
- The [upgrades section of the operations guide](runbook.md#upgrades): add an "Upgrading to
  X.Y.Z" note if the release needs operator action beyond `pull && up -d`.
- If `packages/extension-api` changed, refresh the current contract version in the extension
  versioning policy and plan the package tag (step 5).
- If the CLI's minimum supported version or its built-in withdrawn list
  (`apps/api/src/modules/client-versions/cli-version-policy.ts`) changed, add a "CLI" line under
  the release's Upgrade notes (step 8).
- Open a `docs: prepare vX.Y.Z release` pull request and get it merged.

## 3. Tag and publish

```bash
git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" \
  --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d') \
  --generate-notes
```

`--generate-notes` appends GitHub's pull-request list beneath the hand-written notes.
**Publishing** the release (not saving a draft) is what fires the workflows.

## 4. Watch the workflows

```bash
gh run list --workflow container-publish.yml --limit 1
gh run list --workflow fly-deploy.yml --limit 1
gh run watch <run-id>
```

`container-publish` must pass its "Verify published image version matches the release tag" step
before the alias-promotion job runs. If it fails after the push, do **not** re-run blindly — the
immutable `X.Y.Z` image tag already exists. Follow the verification-failure procedure in
[docs/runbook.md](runbook.md): publish `X.Y.Z+1`, or delete the package versions first and re-run
via `workflow_dispatch`.

Post-publish verification:

```bash
docker buildx imagetools inspect ghcr.io/nestormata/project-vault/api:X.Y.Z
curl -sf https://<demo-api>/health   # expect version X.Y.Z, versionSource "release"
```

## 5. Extension API (only when `packages/extension-api` changed)

The npm package is released independently, on `extension-api-vX.Y.Z` tags. First confirm the
version triangle: `packages/extension-api/package.json`, the top `## X.Y.Z` heading in that
package's CHANGELOG, and the compiled `EXTENSION_API_VERSION` constant must all agree. The
release workflow re-checks this and fails the tag if they do not.

```bash
git tag extension-api-vX.Y.Z && git push origin extension-api-vX.Y.Z
gh run list --workflow extension-api-release.yml --limit 1
gh run watch <run-id>
npm view @project-vault/extension-api dist-tags   # `next` should now be X.Y.Z
```

The workflow publishes to the `next` dist-tag with provenance. Promote it to `latest` by hand,
only after the downstream consumer has verified the build:

```bash
npm dist-tag add @project-vault/extension-api@X.Y.Z latest
```

**Current state (2026-09-09):** npm carries only `1.1.0` on both `latest` and `next`, while the
package source is at `3.15.0`. Twenty intermediate contract versions were never tagged or
published, and they cannot be reconstructed. Publish `3.15.0` only, and note the gap in the
package changelog. Version `3.0.0` contains a breaking change for the CentralizeMe consumer;
coordinate the `latest` promotion with it.

## 6. vault-action (only when `packages/vault-action` changed)

```bash
pnpm check-vault-action-dist
git tag vault-action-vX.Y.Z && git push origin vault-action-vX.Y.Z
```

The tag push moves the floating `vault-action-vN` tag and mirrors `action.yml` plus `dist/` to
the standalone action repository.

## 7. After the release

- Verify the demo deployment, and that its version and upgrade page reports `X.Y.Z`.
- Point operators at the CHANGELOG "Upgrade notes" section.
- Open a fresh `## [Unreleased]` section in the CHANGELOG.

## 8. CLI (every release)

Publishing the `vX.Y.Z` release also runs `.github/workflows/cli-release.yml`, which attaches the
distributable `pvault` CLI to the same GitHub Release. Nothing is committed and nothing is pushed.

What the workflow does:

1. Validates the tag against `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (the same
   check as `container-publish.yml`). Other tags, including `vault-action-v*`, `extension-api-v*`
   and prereleases, fail here and upload nothing.
2. Runs `pnpm --filter "@project-vault/cli..." test` on the **unstamped** tree, exactly as in PR CI.
3. Stamps `X.Y.Z` and the 7-character commit into both `packages/agent/src/build-info.ts` and
   `packages/cli/src/build-info.ts` in one step (`scripts/stamp-build-info.ts`), then builds.
4. Bundles `packages/cli/dist/bin.js` with `@vercel/ncc` into one ESM file, `pvault-X.Y.Z.mjs`.
5. Self-verifies by executing that file on Node 20 (the `engines` floor) and Node 24. Line 1 of
   `--version` must be `pvault X.Y.Z (commit <sha7>)`, line 2 must be `agent  X.Y.Z (commit
   <sha7>)`, stderr must be empty (no CLI/agent skew), and `0.0.1` must not appear.
6. Writes `pvault-X.Y.Z.mjs.sha256` and uploads both files with `gh release upload --clobber`.

Verify it:

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'   # pvault-X.Y.Z.mjs, pvault-X.Y.Z.mjs.sha256
```

Recovery: run the workflow manually from `main` with the `tag` input (`workflow_dispatch`). A
re-run for the same tag replaces the assets. Runs are serialized (concurrency group
`cli-release`, never cancelled).

The committed build-info files must always stay `'dev'`/`null`. `pnpm check-build-info-unstamped`
enforces this in CI, so never commit a locally stamped copy.

Tagging scheme — the CLI **diverges** from `packages/vault-action` on purpose:

| vault-action | CLI | Reason |
| --- | --- | --- |
| Own prefixed tag `vault-action-vX.Y.Z` | Shares `vX.Y.Z` | The CLI's compatibility contract is with *the server of the same release*. A shared number lets the server advertise `current` as its own `RELEASE_VERSION`, with no second manifest to keep in sync. vault-action has no server-compatibility check. |
| Mutable major tag `vault-action-vN`, force-moved | None | An Action is resolved by tag on every run, which is why the mutable tag exists. A CLI is downloaded once and then runs unchanged. A moving tag gives it nothing, and the CLI's own version check detects staleness instead. |
| Mirror repo `nestormata/vault-action` | None; the assets are attached to this repository's Release | The mirror exists only because Marketplace requires `action.yml` at a repository root. The CLI has no such constraint. |
| `dist/` committed, plus the `check-vault-action-dist` freshness gate | `dist` is never committed; it is built at the tag | Nothing resolves the CLI from git, so there is no committed build to drift. The self-verify step replaces the freshness gate. |

## Tooling note

The `gh` version used in this repository does not support `--json` on `gh pr checks`. Parse the
plain tab-separated output instead of asking for JSON.
