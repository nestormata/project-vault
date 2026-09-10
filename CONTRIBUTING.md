# Contributing to Project Vault

Thanks for your interest in contributing. This document covers the practical workflow and the
legal requirements that apply to every external contribution. Participation is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start writing code: the CLA

**When it happens:** you do **not** need to sign anything before you start writing code or
before you open your first pull request. The Contributor License Agreement (CLA) is signed
automatically, from inside the PR itself, the first time an automated bot detects an unsigned
PR from you — it posts a comment with a one-line instruction, and a required status check blocks
the PR from merging until you follow it. There is no separate portal, account, or upfront step.

**Who needs to sign:** every external contributor, for every pull request, with **no
size exception**. Even a one-line typo fix requires a signed CLA before it can be merged. This
is a deliberate simplicity decision, not an oversight: copyright attaches to a contribution
regardless of how small it is, and the sublicensing grant described below matters the same
either way. We chose "always require it" over building and maintaining size-based exception
logic.

**What signing means — read this before you open a PR:**

1. Your contribution stays licensed under AGPLv3 in this repository, forever, exactly like the
   rest of the codebase — the CLA does not take that away.
2. Separately, **you also grant the project maintainer a broad license — including the right to
   sublicense — to use your contribution outside the AGPLv3 terms, including in a closed-source
   commercial product.** Concretely: Project Vault's open-source core is AGPLv3, and the
   maintainer intends to build a commercial hosted SaaS extension on top of it. Contributions
   accepted into this repository may be incorporated into that closed-source commercial product,
   not only into the open-source codebase. This is disclosed here, up front, precisely so no
   contributor is surprised by it later.

The full legal text, including both of these clauses in detail, is in [CLA.md](./CLA.md).
Please read it before your first PR.

**This CLA governs contributions back to this repository only.** It does not restrict what you
or anyone else does with Project Vault's own AGPLv3 source code in a self-hosted deployment or a
fork — that remains governed solely by the AGPLv3 license terms in [LICENSE](./LICENSE),
unaffected by whether you've ever signed the CLA.

> **Not legal advice.** The CLA text is a solid starting draft but has not yet been reviewed by
> an attorney; see the caveat at the top of [CLA.md](./CLA.md). It also currently covers
> individual contributors only — a corporate variant is a documented future addition.

## How to contribute

1. Open an issue or discussion first for anything nontrivial, so scope and approach can be
   agreed before you invest time.
2. Fork the repository and branch from `main`.
3. Set up your environment following the [development guide](./docs/development.md).
4. Make your change, then run the local quality gates (see [Before you push](#before-you-push)).
5. Open a pull request against `main`. The PR template will remind you of the CLA requirement.
6. On your first PR, the CLA bot will comment with signing instructions if you haven't signed
   yet; the PR cannot merge until the required "CLA signed" status check passes.
7. Address review feedback; once approved and the CLA check passes, a maintainer will merge.

## Repository boundary

This public repository is the complete distributable Project Vault application: source code,
design specifications, documentation, Docker configuration, and the workflows required to build,
test, deploy, and operate it. A checkout of this repository does not require access to any other
repository.

Maintainers keep planning artifacts, agent instructions, and internal development output in a
separate private repository. That overlay is not part of the public product, is not required for
external contributions, and must not be added to this repository.

## Branching and commits

- Branch from `main`. Name feature branches `feature/<slug>` — for example
  `feature/credential-share-expiry`.
- Rebase or merge `main` into your branch to resolve conflicts; keep the history readable.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and are
  validated by commitlint, both in a local `commit-msg` git hook and again on every pull request.
  The type must be one of:

  | Type | Use for |
  |---|---|
  | `feat` | A user-visible capability |
  | `fix` | A bug fix |
  | `chore` | Dependencies, tooling, build plumbing |
  | `docs` | Documentation only |
  | `refactor` | Behavior-preserving code change |
  | `test` | Tests only |

  Any other type — `perf`, `ci`, `style`, `build`, `revert` — is rejected. A subject line looks
  like `fix(auth): reject expired recovery tokens before the TOTP check`.
- A `pre-commit` hook runs ESLint and Prettier over your staged TypeScript, JavaScript, and
  Svelte files, so formatting is fixed for you rather than argued about in review.

## Before you push

Run the full local gate sequence:

```bash
make ci
```

`make ci` **runs inside Docker** against a Postgres container it starts itself, isolated per
worktree. You do **not** need a local Postgres on port 5432 for it. It moves busy host ports out
of the way first, then runs everything below in one container, and finishes with a Docker
backup-permission smoke test on the host (which does need a working Docker socket).

| Gate | Command | What it checks |
|---|---|---|
| Typecheck | `pnpm turbo typecheck` | Strict TypeScript, including `noUncheckedIndexedAccess` |
| Lint | `pnpm turbo lint` | ESLint flat config, including security and entropy-based secret-detection rules |
| Migrations | `pnpm db:migrate` | Every migration applies cleanly behind the destructive-migration guard |
| RLS coverage | `pnpm check-rls` | Every table has row-level-security policy coverage, checked as `vault_app` |
| Function executability | `pnpm check-function-executability` | No database function is executable by a role that should not have it |
| Migration compatibility | `pnpm check-migration-compatibility` | Static scan for migrations an operator could not upgrade through |
| Extension API contract | `pnpm check-extension-api-*` | Surface snapshot, behavior snapshot, contract-hash changelog entry, version skew |
| Tests | `pnpm turbo test` | Vitest, with branch-coverage thresholds enforced per package |
| Duplication | `pnpm jscpd` | No duplicated code blocks |
| Environment parity | `pnpm tsx scripts/check-env-example.ts` | Every environment-schema key appears in `.env.example` |
| Dependency audit | `pnpm audit --audit-level=high` | No high or critical advisories outside the tracked baseline |
| OpenAPI freshness | `pnpm generate-spec` | The committed `packages/shared/openapi.json` matches the routes |

Two more, run separately:

```bash
make check-public-safety BASE_REF=origin/main   # nothing private is about to be published
make docker-smoke                               # end-to-end /health and /ready against the built stack
```

`make ci` also runs a handful of maintainer-only consistency checks against the private planning
overlay. If one of those fails in a fork, it is not something your change caused — say so in the
pull request and a maintainer will confirm.

On GitHub, every pull request additionally runs CodeQL over the Actions workflows and the
TypeScript sources, and a SonarCloud analysis with a quality gate on new code. Nightly runs add
Stryker mutation testing and a Trivy scan of the built container images.

## Adding a database migration

Migrations live in `packages/db/src/migrations` and are applied by a guarded runner, not by
`drizzle-kit` directly.

1. Change the schema under `packages/db/src/schema/`.
2. Generate the SQL:

   ```bash
   pnpm --filter @project-vault/db generate
   ```

3. Read the generated `.sql` file. Rename it to something descriptive if the generated name is
   opaque, and keep the journal entry in `meta/_journal.json` in step with it.
4. Apply it locally as the superuser:

   ```bash
   pnpm db:migrate     # or: make db-migrate
   ```

   The runner refuses to apply a migration it classifies as destructive unless the migration is
   on the reviewed-destructive allowlist or you pass `--allow-destructive`. If your migration
   trips the guard, that is a design conversation to have in the issue, not a flag to add.

5. Add row-level-security policies for any new tenant-owned table and re-run `make check-rls`.
   A table without policy coverage fails CI.
6. Run `pnpm check-migration-compatibility` and `pnpm check-function-executability`.
7. Note anything an operator must do — a backfill, a maintenance window, a new environment
   variable — in the pull request. It becomes an entry in the CHANGELOG's Upgrade notes.

## Changing the extension API

`packages/extension-api` is a published npm package with an independent version line and a
formal compatibility contract. Its versioning and deprecation policy is linked from
[docs/extensions/README.md](./docs/extensions/README.md); read it before changing anything
exported from the package.

Any change to the exported surface or to loader behavior requires all of the following, or CI
fails:

1. **Bump the package version** in `packages/extension-api/package.json` and the
   `EXTENSION_API_VERSION` constant together — a version-skew guard compares them.
2. **Regenerate the surface snapshot.** From `packages/extension-api`:

   ```bash
   pnpm tsx tests/api-surface.ts --write
   ```

   This rewrites `api-surface.snapshot.md` from the compiler's view of the public types. Commit
   it, and classify the change (additive, deprecating, or breaking) in your pull request.
3. **Add a CHANGELOG entry** in `packages/extension-api/CHANGELOG.md` for the new version,
   including the contract hash. The hash is computed over `api-surface.snapshot.md` plus
   `contract-behaviour.snapshot.md`; `pnpm check-extension-api-contract-changelog` verifies the
   entry matches. A `### Deprecated` block additionally requires a `Notified:` line recording the
   notice window.
4. **Update `contract-behaviour.snapshot.md`** if you changed the reverse-DNS name pattern,
   prerelease acceptance, the loader timeout, or the failure-reason-to-status mapping.
5. Run the gates:

   ```bash
   pnpm check-extension-api-policy
   pnpm check-extension-api-policy-content
   pnpm check-extension-api-behaviour
   pnpm check-extension-api-markers
   pnpm check-extension-api-contract-changelog
   pnpm check-extension-api-version-skew
   ```

Releasing the package is a separate, tag-driven step described in
[docs/releasing.md](./docs/releasing.md).

## The `.env.example` sync gate

`.env.example` is not documentation that can lag — it is enforced. `scripts/check-env-example.ts`
fails CI when any key in the API's environment schema is missing from `.env.example`. If you add
a configuration key, add it to `.env.example` in the same commit, with a comment explaining what
it does and a safe default. Do not defer this: it blocks the merge.

## Review expectations

- **Scope.** One logical change per pull request. Split refactors out from behavior changes so a
  reviewer can see what actually changed.
- **Tests.** New behavior needs tests. Bug fixes need a test that fails before the fix. Coverage
  thresholds are enforced per package, and a single failing test suppresses coverage reporting
  for its whole package — so land your branch green, not "green except one".
- **Security-sensitive paths.** Changes to authentication, key custody, row-level security,
  database roles and grants, or audit writes get a closer read and may take longer. Explain the
  threat model you had in mind in the pull request description.
- **Secrets never surface.** No credential value, token, or key may reach a log line, an error
  message, a stack trace, or a test fixture that gets printed.
- **Documentation.** If your change alters what an operator must do, update the relevant guide
  under [docs/](./docs/README.md) in the same pull request.
- **Failing gates.** Fix the underlying issue. Adding a lint suppression, a duplication
  exception, or a scanner ignore entry instead of a fix will be sent back.
- Maintainers review on a best-effort basis. A ping on a pull request that has been quiet for a
  week is welcome, not rude.

## Reporting security issues

Do not open a public issue for a security vulnerability. Follow the process in
[SECURITY.md](./SECURITY.md).
