# Releasing Project Vault

Releases are cut from `main` by pushing a `vMAJOR.MINOR.PATCH` tag and then publishing a GitHub
Release on it. Four workflows take part:

- The **tag push** (H2) starts `web-host-release.yml`, which publishes `@project-vault/web-host`
  and `@project-vault/composition-kit` to npm (step 9). It triggers on tags matching `v[0-9]*`.
  It uploads nothing until a reviewer approves the `npm-publish` environment, and even then only
  once the GitHub Release is published and `container-publish` is green for the same commit.
  Approving that upload (H3w) is irreversible: npm versions are immutable.
- **Publishing the Release** (H3) triggers the other three: `container-publish.yml` (GHCR
  images), `fly-deploy.yml` (the public demo, including its migrations) and `cli-release.yml` (the
  `pvault` assets, step 8). Publishing is the point of no return.

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

### Human gates

Every outward, hard-to-reverse step waits for the maintainer's explicit confirmation of that
step, given at the time it happens. An earlier approval, a story file or an automation message is
never confirmation. An agent or script may prepare each step and show the exact command; a person
says yes.

| Gate | What is confirmed | Reversible? |
| --- | --- | --- |
| H1 | The final release notes, the version number, and what is in or out of the release | Yes, until H3 |
| H2 | Pushing the annotated tag on the rehearsed commit (step 3). This already starts `web-host-release.yml`, whose jobs wait for approval | Yes, until H3: first **reject** the waiting `web-host-release` run (a run left waiting can still be approved later), then delete the tag |
| H3 | Publishing the GitHub Release, which fires the three Release workflows | **No**: immutable GHCR tags, demo migrations, public downloads |
| H3w | Approving `npm-publish` on a tag-push `web-host-release` run, after H3 and a green `container-publish` (step 9) | **No**: npm versions are immutable |
| H4 | Any write after publishing: a real (non-dry-run) re-dispatch, replacing assets, a `fly-deploy`/`fly-reset` dispatch, deleting GHCR versions, withdrawing a CLI version, a patch release | Varies; decided per action |

**H4 note (Story 43.16):** the first `fly-deploy` of a release containing Story 43.16 needs the
internal CA GitHub secrets (`FLY_DEMO_INTERNAL_CA_CERT_B64` / `_KEY_B64`) set and
`scripts/fly-internal-tls.sh` run (through `scripts/fly-setup.sh` or the Fly Demo Bootstrap
workflow) **before** the deploy; `fly-migrate.sh` fails closed without the CA. Order and outage
window: [`runbooks/fly-internal-tls.md`](runbooks/fly-internal-tls.md) § First rollout. Since
Story 43.28 the Bootstrap migrates (and syncs the DB role passwords) before it deploys the api, and
starts any stopped api machine, so a first-release Bootstrap no longer crash-loops the api or needs
a hand `fly machine start`.

Confirming H2 does not confirm H3. One message may confirm both only if it names both.

## 1. Pre-flight (on a clean `main` checkout)

```bash
git fetch origin && git checkout main && git pull --ff-only
git log --format='%h %s' v<prev>..HEAD
git diff --stat v<prev>..HEAD -- packages/db/src/migrations .env.example docker-compose*.yml
pnpm check-migration-compatibility          # static scan of every migration
pnpm tsx scripts/check-env-example.ts       # environment schema vs .env.example
pnpm check-extension-api-version-skew       # contract bump present if the surface changed
pnpm check-extension-api-contract-changelog # changelog entry plus contract hash
make ci                                     # or confirm the last main CI run is green
```

Once the step-2 release-notes pull request has merged, choose the **candidate commit** (normally
that merge commit) and rehearse the CLI release on it before any tag exists:

```bash
SHA=$(git rev-parse origin/main)                 # the candidate; main must still point here
gh run list --workflow ci.yml --branch main --commit "$SHA"   # must be success
gh workflow run cli-release.yml --ref main -f tag=vX.Y.Z -f dry_run=true
gh run list --workflow cli-release.yml --limit 1 # note the run id
gh run view <run-id> --json headSha --jq .headSha   # must equal $SHA
gh run watch <run-id>                            # release, verify (20), verify (24) green; publish skipped
```

**Tag the rehearsed SHA.** The tag in step 3 goes on exactly the commit the dry-run built, never on
"whatever `main` is now". If `main` moved after the dry-run, either re-run the dry-run on the new
head or tag the rehearsed SHA explicitly; anything merged after the candidate goes under
`[Unreleased]` for the next release.

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
git fetch origin
git ls-remote --tags origin vX.Y.Z             # must be empty
gh release view vX.Y.Z                         # must say "release not found"
git tag -a vX.Y.Z <sha> -m "vX.Y.Z"            # <sha> = the rehearsed candidate (step 1)   [H2]
git push origin vX.Y.Z
git ls-remote --tags origin 'vX.Y.Z^{}'        # must print <sha>
gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --latest \
  --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d') \
  --generate-notes                             #                                            [H3]
```

The `git push` (H2) already starts `web-host-release.yml`. Its jobs wait for the `npm-publish`
approval; leave them waiting until H3 and a green `container-publish` (step 9).

`--verify-tag` makes `gh` refuse to run if the tag does not exist on the remote, so it can never
create one implicitly on the default branch's head. `--generate-notes` appends GitHub's
pull-request list beneath the hand-written notes. **Publishing** the release (not saving a draft)
is what fires the workflows. Never force-move or delete a release tag once the Release is
published; a mistake after that point is fixed forward with a patch release.

## 4. Watch the workflows

```bash
gh run list --workflow container-publish.yml --limit 1
gh run list --workflow fly-deploy.yml --limit 1
gh run watch <run-id>
```

`container-publish` must pass its "Verify published image version matches the release tag" step
and its per-platform "Scan published image for vulnerabilities" steps before the alias-promotion
job runs. A failed vulnerability scan leaves `X.Y.Z` published but un-promoted: fix the finding and
cut `vX.Y.(Z+1)` (see
[container-images.md](container-images.md#release-vulnerability-gate)). If the version
verification fails after the push, do **not** re-run blindly — the immutable `X.Y.Z` image tag
already exists. Follow the verification-failure procedure in
[docs/runbook.md](runbook.md): publish `X.Y.Z+1`, or delete the package versions first and re-run
via `workflow_dispatch`. The second option repairs the images only: the web-host Release gate
(§9.2) does not count a `workflow_dispatch` run, so web-host `X.Y.Z` is then never published.
Choose `X.Y.Z+1` whenever web-host must ship for this release.

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

**Current state (2026-10-04):** npm `latest` is `3.25.0` and `next` is `3.29.0` (published tags:
`extension-api-v1.1.0`, `-v3.15.0`, `-v3.23.0`, `-v3.24.1`, `-v3.25.0`, `-v3.27.0`, `-v3.29.0`). `3.27.0` (Story 68.8,
M7 `apiRoutes`) was tagged on merge commit `c610e486`, published by run `37088769144` (shasum
`7f9423e286a678c41a679363ff1d170c90df83df`). `3.29.0` (Story 68.14, app-level `apiRoutes`) was tagged on
`49c27b34` and published by run `37166931749` on 2026-10-04; it includes `3.28.0` (Story 71.1), which was never
published on its own. `latest` moves only after CentralizeMe verifies the version.
`3.26.0` was never published (71.1 renumbered to `3.28.0` after 68.8 took `3.27.0`). `3.24.2` was a
documentation-only patch that was never published; `3.25.0` supersedes it.
`3.24.0` was never tagged and is superseded by `3.24.1`. Every other intermediate contract version
was never tagged or published, and cannot be reconstructed.
Version `3.0.0` contained a breaking change for the CentralizeMe consumer: coordinate every `latest`
promotion with it.

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
   `--version` must be `pvault X.Y.Z (commit <sha7>)`, line 2 must be
   `agent  X.Y.Z (commit <sha7>)`, stderr must be empty (no CLI/agent skew), and `0.0.1` must not
   appear.
6. Writes `pvault-X.Y.Z.mjs.sha256` and uploads both files with `gh release upload --clobber`.

Verify it:

```bash
gh release view vX.Y.Z --json assets --jq '.assets[].name'   # pvault-X.Y.Z.mjs, pvault-X.Y.Z.mjs.sha256
```

Recovery: run the workflow manually from `main` with the `tag` input (`workflow_dispatch`,
`dry_run` false). A re-run for the same tag replaces the assets. Real runs are serialized in the
concurrency group `cli-release` and never cancelled in progress, but GitHub keeps only one
*pending* run per group: a second dispatch queued behind a pending one cancels it. Never dispatch
a recovery while a run for the same tag is queued or in progress, and before any recovery check
that `git ls-remote --tags origin 'vX.Y.Z^{}'` still points at the released commit. The ruleset
"Protect PV release tags" restricts only the creation of `refs/tags/v[0-9]*` (bypass: the
maintainer); moving or deleting such a tag is not restricted, so "never force-move a published
tag" is still a procedural rule. **Recovery dispatch works for `v1.3.0` and later only**: older tags do not contain
`scripts/stamp-build-info.ts`, so the run fails at stamping and uploads nothing.

### Dry-run (`dry_run: true`)

```bash
gh workflow run cli-release.yml --ref <branch> -f tag=vX.Y.Z -f dry_run=true
gh run download <run-id> -n pvault-bundle -D /tmp/pvault-dry
node /tmp/pvault-dry/pvault-X.Y.Z.mjs --version   # commit = short SHA of <branch>'s head, not of any tag
```

What a dry-run does: validates the tag string with the same regex, checks out **the dispatching
commit** (`github.sha`; the tag need not exist yet) through its own checkout step with no `ref:`
(a real run takes the other, mutually exclusive checkout step, pinned to the validated tag), runs
the same test, stamp, build, bundle and Node 20/24 self-verify steps, and writes
`DRY RUN: nothing uploaded; bundle kept as artifact pvault-bundle (1 day); do not distribute` to
the job summary.

What it does not do: the `publish` job never runs, so the run never holds `contents: write`, no
Release is read or changed, nothing is pushed, and GHCR and Fly are untouched. A dry-run may be
dispatched from any branch (so a pull request can rehearse itself before merging); a real dispatch
is still refused outside `main`.

- The bundle is kept as a workflow artifact for **1 day** (7 days for a real run). Artifacts of a
  public repository can be downloaded by any signed-in GitHub user, and a dry-run bundle calls
  itself `pvault X.Y.Z`. It embeds the dry-run's commit, so its SHA-256 never matches the
  Release's. **The only authentic `pvault` is the Release asset whose SHA-256 matches that
  Release's `.sha256` file.** Never distribute a dry-run bundle.
- Dry-runs use their own concurrency group (`cli-release-dry-run`), so they never cancel a
  pending real release. Even so, do not dispatch a dry-run while a real `cli-release` run is queued
  or running.
- If a dry-run fails, fix the cause and dispatch a new dry-run. Do not "re-run failed jobs" and
  treat a later green result as proof for a different commit.

### Prerequisite: immutable releases stay disabled

`cli-release.yml` attaches its assets **after** the Release is published. If GitHub's immutable
releases setting is ever enabled for this repository
(`gh api repos/nestormata/project-vault/immutable-releases` reports `enabled`), assets can no
longer be added after publishing and every `publish` job fails. Before enabling it, change the
procedure so the CLI assets are uploaded to a draft Release before it is published.

### What the checksum does and does not prove

The `.sha256` file sits on the same Release as the bundle, so it detects a corrupted or wrong
download. It does **not** detect a compromise of the repository or of the release process: anyone
able to replace the bundle can replace its checksum too. The bundle is not signed and carries no
build-provenance attestation yet. Creation of `refs/tags/v[0-9]*` is restricted by the ruleset
"Protect PV release tags" (bypass: the maintainer), but moving or deleting such a tag is not
restricted, so "never force-move a published tag" is still procedural.

The committed build-info files must always stay `'dev'`/`null`. `pnpm check-build-info-unstamped`
enforces this in CI, so never commit a locally stamped copy.

Tagging scheme — the CLI **diverges** from `packages/vault-action` on purpose:

| vault-action | CLI | Reason |
| --- | --- | --- |
| Own prefixed tag `vault-action-vX.Y.Z` | Shares `vX.Y.Z` | The CLI's compatibility contract is with *the server of the same release*. A shared number lets the server advertise `current` as its own `RELEASE_VERSION`, with no second manifest to keep in sync. vault-action has no server-compatibility check. |
| Mutable major tag `vault-action-vN`, force-moved | None | An Action is resolved by tag on every run, which is why the mutable tag exists. A CLI is downloaded once and then runs unchanged. A moving tag gives it nothing, and the CLI's own version check detects staleness instead. |
| Mirror repo `nestormata/vault-action` | None; the assets are attached to this repository's Release | The mirror exists only because Marketplace requires `action.yml` at a repository root. The CLI has no such constraint. |
| `dist/` committed, plus the `check-vault-action-dist` freshness gate | `dist` is never committed; it is built at the tag | Nothing resolves the CLI from git, so there is no committed build to drift. The self-verify step replaces the freshness gate. |

## 9. web-host (every release)

The `vX.Y.Z` tag push starts `web-host-release.yml`. It publishes PV's web source as
`@project-vault/web-host` `X.Y.Z`, and first the composition kit
(`@project-vault/composition-kit`, its own semver, skipped when that kit version is already on
npm), both to the npm `next` dist-tag with OIDC trusted publishing and provenance. No npm token
exists. The package is described in [web-host-package.md](web-host-package.md).

Release-day checklist (the details follow below):

1. Prerequisites hold (9.1). The release commit contains the Story 68.12 workflow. **[before H2]**
2. Push the tag (§3). The real `web-host-release` run starts and waits for approval. **[H2]**
3. Dispatch the dry run on the tag, check its identity, approve it, and wait until it is green. **[H2]**
4. Publish the GitHub Release (§3). **[H3]**
5. Wait for `container-publish` to be green, including its scans and alias promotion (§4). **[H3]**
6. Check the real run's identity, then approve its kit jobs and, later, its web-host jobs. **[H3w]**
7. Verify both packages with `scripts/verify-npm-release.ts` (9.5). **[after H3w]**
8. Record: update "Current state" and tell the CentralizeMe maintainer the exact versions (9.8).
9. After CentralizeMe builds against the exact version: promote to `latest` and verify again. **[H4]**

### 9.1 Prerequisites

- The npm trusted publisher of both packages is `nestormata/project-vault`,
  `.github/workflows/web-host-release.yml`, environment `npm-publish`.
- The `npm-publish` environment has a required reviewer and the tag policy `v[0-9]*`, and the
  ruleset "Protect PV release tags" covers `refs/tags/v[0-9]*`. The workflow triggers on the same
  pattern, so `vault-action-v*` and `extension-api-v*` tags never start it.
- **The tag's workflow file is what runs.** The tag push, a dry run dispatched on the tag and
  "re-run failed jobs" all use `web-host-release.yml` as it is at the tagged commit. A tag on a
  commit older than the Story 68.12 merge runs the old workflow (no Release gate).
- First release only: the composition kit had to exist on npm with its own trusted publisher
  (Story 68-13, done 2026-10-03), because `publish` needs `publish-kit`.

Run this to check them (read-only; `npm trust list` needs `npm login`):

```bash
npm view @project-vault/web-host dist-tags versions deprecated --json
npm trust list @project-vault/web-host --json
npm trust list @project-vault/composition-kit --json
gh api repos/nestormata/project-vault/environments/npm-publish/deployment-branch-policies --jq '.branch_policies[].name'
gh api repos/nestormata/project-vault/rulesets/24388933 --jq '{conditions, rules: [.rules[].type]}'
git merge-base --is-ancestor <68.12 merge sha> vX.Y.Z && echo "workflow is current"   # after H2
```

### 9.2 Sequence

The real run starts at H2, before the GitHub Release exists, and waits for the `npm-publish`
approval. Leave it waiting. Rehearse with a dry run dispatched on the tag. A dry run uses its own
concurrency group, so it never queues behind or cancels the waiting real run. It runs every gate,
reports the Release gate without failing, and uploads nothing. Run this (`gh workflow run` must
be typed by the maintainer; it is blocked in agent sessions):

```bash
gh workflow run web-host-release.yml --ref vX.Y.Z -f dry_run=true
gh run list --workflow web-host-release.yml --limit 2      # the push run (waiting) and the dry run
```

Approve the dry run after the identity check in 9.3. Its gate prints
`Release: missing (expected before H3)` and `container-publish: missing ...` and passes. Then
publish the GitHub Release (H3), wait for `container-publish` to be green (§4), and approve the real
run (H3w).

The Release gate makes an early approval harmless. Without a published, non-draft Release for the
tag and a successful `container-publish` run triggered by that tag's Release (event `release`,
`head_branch` = the tag, `head_sha` = the tag's commit), each job fails before any upload with
"no version was consumed". A `workflow_dispatch` recovery of `container-publish` does not count:
it runs from `main`, so its commit does not identify the tag it built. Its run name shows the tag,
but the gate does not trust a run name (DW-508 records the stronger design to revisit if needed).

Recovery depends on where the Release-triggered `container-publish` run failed:

- **Before any image was pushed**, for a transient reason (a cancelled or flaky job), and within
  GitHub's re-run window: **re-run its failed jobs** (that keeps the `release` event). Once it is
  green, **re-run failed jobs** on the waiting web-host run.
- **Anything else**: a failure after the push (version verification, or a vulnerability scan that
  left `X.Y.Z` published but not promoted), a workflow bug fixed after the tag, or a run older than
  the re-run window. A re-run cannot help: "Reject existing immutable release tag" stops it after
  the push, and a re-run uses the tagged commit's workflow file. Fix forward with `vX.Y.(Z+1)`;
  web-host `X.Y.Z` is skipped and never published. Precedent: v1.0.1's `container-publish` hit a
  workflow bug (run 31212977824), and v1.0.2 shipped the next day.

If the gate says "GitHub API error; retry the failed jobs", re-run the failed jobs.

A job waiting for approval fails after 30 days (GitHub limit). If H3 takes that long, use
**re-run all jobs** on the same tag; no version is consumed.

The upload step is preceded by "Fail if the tag moved": the job checks out `github.sha` (the commit
the provenance attests) and refuses to publish if `vX.Y.Z` no longer names it. Never move a release
tag; if this check fires, investigate before anything else.

### 9.3 Approvals

Each run has four jobs in the `npm-publish` environment: `publish-kit` (Node 20 and 24), then
`publish` (Node 24 and 26). The review screen approves the jobs waiting at that moment, so a run
normally asks twice: once for the kit legs and once for the web-host legs after the kit finishes. A
run in "waiting" is not hung. Only the Node 24 leg of each job uploads.

**Before every approval**, run this and compare:

```bash
gh run view <run-id> --json event,headBranch,headSha,displayTitle
git ls-remote --tags origin 'vX.Y.Z^{}'                    # must print the same headSha
```

`event` must be `push` for the real run, or `workflow_dispatch` for the dry run you dispatched.
`headBranch` must be `vX.Y.Z`, and `headSha` must equal the `ls-remote` commit. Reject anything
else. `gh run view --log` is empty for these runs; run this to read the job states:

```bash
gh api repos/nestormata/project-vault/actions/runs/<run-id>/jobs --jq '.jobs[]|[.name,.status,.conclusion]|@tsv'
```

### 9.4 npm writes need a real terminal

`npm dist-tag` and `npm deprecate` need two-factor authentication with the maintainer's security
key. That works only in a real terminal (TTY). A `!` command typed into an agent prompt fails with
`EOTP`, because npm skips both the web and the classic one-time-password flow without a TTY. A
stale local login fails with `E401` first: run `npm login`, then repeat the command, adding
`--otp=<code>` if npm asks for one.

### 9.5 Verify

`scripts/verify-npm-release.ts` is read-only. It checks the version exists, the expected dist-tag
points at it, it is not deprecated, and its SLSA provenance names this repository, this workflow
and `refs/tags/vX.Y.Z`. It also checks that the attested digest equals the tarball's
`dist.integrity`. The registry can lag about 5 minutes behind a successful upload; `--wait`
polls every 30 seconds while the version or dist-tag is missing. Run this after H3w:

```bash
pnpm exec tsx scripts/verify-npm-release.ts --package @project-vault/web-host \
  --version X.Y.Z --tag vX.Y.Z --expect-dist-tag next --wait 600
pnpm exec tsx scripts/verify-npm-release.ts --package @project-vault/composition-kit \
  --version <kit version> --tag vX.Y.Z --expect-dist-tag next --wait 600   # only if the kit was published
```

Every line must be `ok`. The helper checks registry metadata and the attestation's claims, not the
Sigstore signature. The signature check is `npm audit signatures`, run in a project that installed
the exact version (CentralizeMe's build does it). Example:

```bash
npm install --save-exact @project-vault/web-host@X.Y.Z && npm audit signatures
```

To read dist-tags without the `npm view` cache lag (example):

```bash
curl -s https://registry.npmjs.org/@project-vault%2fweb-host | python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"
```

### 9.6 Promote to `latest`

Only after CentralizeMe has built against the exact `X.Y.Z` (pinned, never following `next`) and
its `npm audit signatures` passed. Run this in a real terminal (9.4):

```bash
npm dist-tag add @project-vault/web-host@X.Y.Z latest
pnpm exec tsx scripts/verify-npm-release.ts --package @project-vault/web-host \
  --version X.Y.Z --tag vX.Y.Z --expect-dist-tag latest --wait 600
```

Until the first promotion, `npm i @project-vault/web-host` without a version installs the
deprecated bootstrap placeholder. Consumers always pin the exact version.

### 9.7 Rollback

- **A bad version on `next`:** publish a fixed `vX.Y.(Z+1)`. Never `--force`, never re-use a
  number.
- **A bad version that reached `latest`:** re-point `latest` and deprecate the bad version
  (example values; real terminal):

  ```bash
  npm dist-tag add @project-vault/web-host@<previous good> latest
  npm deprecate @project-vault/web-host@<bad> "<reason>; use X.Y.Z"
  ```

- `npm unpublish` is not used (project rule). npm itself allows it only within 72 hours and only
  when no other package depends on the version, and a version number can never be re-used, even
  after unpublishing.
- `latest` can be re-pointed but not removed: `npm dist-tag rm @project-vault/web-host latest` is
  refused.
- **A compromised release:** follow the extension-api incident list in
  `.github/workflows/extension-api-release.yml`: revoke the trusted publisher, disable the
  `npm-publish` environment, publish a security advisory, and notify the CentralizeMe maintainer.

Re-running the workflow after a successful publish fails the "not already on npm" gate by design.

### 9.8 Record

After every release: paste the 9.5 helper output into the release record, update "Current state"
below, and tell the CentralizeMe maintainer the exact web-host version, the kit version and the
`apiImageTag`, all read from the published tuple. Run this:

```bash
npm pack @project-vault/web-host@X.Y.Z --pack-destination /tmp
tar -xOf /tmp/project-vault-web-host-X.Y.Z.tgz package/manifests/compatibility.json
```

That message is the signal for CentralizeMe's implementation gate (CM-E16 16-1). CentralizeMe
pins exactly and never follows `next`.

**Current state (2026-10-04):** `v1.4.0` (tag on `4a17f55d`) was the first release to publish both packages:
`@project-vault/web-host@1.4.0` and `@project-vault/composition-kit@0.7.0`, with provenance verified by
`scripts/verify-npm-release.ts` (push run `37170315890`, preceded by the dry run `37170400167`; both
`publish-kit` legs finished before any `publish` leg started). CentralizeMe 16-1 pins both versions exactly.
Both packages were promoted to `latest` on 2026-10-04 (`npm dist-tag add … latest`, registry modified
10:33Z), so the dist-tags are `latest` = `next` = `1.4.0` (web-host) and `0.7.0` (composition-kit). The
placeholder `0.0.1-bootstrap.0` stays deprecated on both ("use the latest dist-tag" is accurate again). The
`bootstrap` dist-tag is removed on both packages (composition-kit on 2026-10-04, 14:02Z), leaving only
`latest` and `next`.

## Tooling note

The `gh` version used in this repository does not support `--json` on `gh pr checks`. Parse the
plain tab-separated output instead of asking for JSON.
