# Story 1.13: Infra and Process Hardening

Status: ready-for-dev

<!-- Completion-round-2 grab-bag for Epic 1 (same pattern as 5-5/6-4/8-6/8-7/9-7/9-8), bundling four
     small, unrelated, low-risk items from `deferred-work.md` that had no reason to skip but also no
     natural home in another epic. UNLIKE most other completion stories, these four items are NOT
     thematically unified — each AC group (D, P, T, C) below is fully self-contained: read only the
     group you're implementing, in any order, and even a partial PR (e.g. just Group T) is safe to
     ship on its own. Do not assume cross-group dependencies; there are none. -->

## Story

As Nestor (repo maintainer/operator) and as Amelia (the dev agent implementing future stories),
I want four small, independent process/infra gaps closed — a slow one-shot `migrate` Docker build,
a still-missing regression test tying the already-shipped Status-header-drift CI check to its own
history of recurrences, inconsistent tag-case handling on projects/credentials, and dead
placeholder-copy code left behind by two prior cleanups —
so that: (D) `docker compose up`/`make bootstrap-docker` cold-builds don't waste time compiling
`packages/agent`/`apps/api` just to run a migration; (P) the already-built `check-story-status-sync`
guard's provenance is traceable to the exact historical incidents it exists to prevent, and this
story's own file doesn't become the *next* recurrence; (T) a user who tags a credential `Prod` and
later searches or re-tags it `prod` gets one consistent tag, not two silently-diverging ones; and
(C) nobody wastes time debugging or "fixing" a placeholder component that no route has rendered in
months.

*Closes: `deferred-work.md` § "Open (Epic 1 retro)" D4; § "Deferred from: Epic 6 retrospective
(2026-07-06)" § "Open (Epic 6 retro)" P6-1; § "Security & permissions (cross-epic — explicit
deferrals)" tag-case-normalization row (Story 2.3 ADR-2.3-01); § "Shell placeholders" "Stale copy"
bullet.*
[Source: `_bmad-output/implementation-artifacts/deferred-work.md`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

This story's four groups have four different, deliberately-not-unified surface scopes — evaluated
independently, not as one blanket answer:

| Group | Surface scope | Rationale |
|-------|---------------|-----------|
| **D** — migrate build split | `none` | Pure Docker build-graph restructuring. No API contract, no route, no schema, no user-visible behavior changes at all — the `migrate` one-shot container's command, environment, and output are byte-for-byte identical before/after; only *which Dockerfile stage produces the image* changes. |
| **P** — status-sync check hardening | `none` | Pure internal CI/process tooling. `check-story-status-sync` (already shipped, see Background) has no runtime component and is invisible to any end user, evaluator, or org member. |
| **T** — tag case normalization | `api` | Behavior change is entirely server-side (normalize-on-write + normalize-on-filter). **No web code changes required or made** — `apps/web`'s existing tag `<input>` fields (credential/project tag entry) already just POST/PUT whatever string the user typed; they transparently inherit the new normalization with zero UI diff. Evaluator-visible: yes (typing `Prod` now visibly renders back as `prod`) but requires no linked UI story since the existing UI already correctly displays whatever the API returns — there is no UI gap to track. |
| **C** — `placeholder-copy.ts` cleanup | `web` | Frontend-only dead-code deletion. Evaluator-visible: **no** — by this story's own AC-C1 finding, the code being removed is not rendered by any route today (nor was it before this story), so removing it is a no-op from any user's perspective. This is the opposite of a UI gap: it's confirming there never was a live surface here to begin with (same class of finding as Stories 6.3/9.7's `health`/`settings` removals). |

**Linked UI story** (if API-only): N/A for all four groups — Group T is `api` but has no UI gap (see
above); the other three groups are `none`/dead-code and have no UI surface at all.

**Honest placeholder AC**: N/A — nothing in this story defers any UI.

### Persona journey stub

**Alex (org member, tags a credential):** Alex creates a credential and types `Prod` into the tags
field (existing UI, unchanged). Today, if Alex later types `prod` on a different credential, search
and the tag filter treat them as two unrelated tags — Alex's "prod" filter silently misses the
`Prod`-tagged credential. After Group T ships, both normalize to `prod` on save; Alex's filter finds
both, and the tag list never shows visually-duplicate near-identical tags. No new screen, no new
control — same tag input, same tag list, just consistent casing.

**Nestor (operator, cold `make bootstrap-docker`):** Today, a fresh clone's first
`docker compose up --build` compiles `packages/crypto` (argon2 tsc output), `packages/agent`, and
`apps/api` before the one-shot `migrate` container can even start, even though migrating only needs
`packages/shared`+`packages/db`. After Group D ships, the same command produces an identical running
stack, but `migrate`'s own build no longer waits on (or can be broken by) unrelated `agent`/`api`
compile errors.

**Amelia (dev agent, next story after this one):** Runs `pnpm check-story-status-sync` before
opening a PR (already wired into `make ci`) and sees this story's own `Status:` header agree with
`sprint-status.yaml` at every transition — Group P's AC-P3 makes this story dogfood the very check
it hardens.

Groups D, P, and C have no further persona-facing journey — see the Product Surface Contract table
above for their `none`/dead-code rationale.

---

## Background: What Already Exists (Read Before Coding, Per Group)

### Group D — `apps/api/Dockerfile`'s `builder` stage and the `migrate` service

**Current structure** (`apps/api/Dockerfile`, 73 lines total):

```1:36:apps/api/Dockerfile
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

RUN npm install -g pnpm@11.9.0
# argon2 (packages/crypto) is a native module. node-gyp-build falls back to compiling
# from source when no bundled prebuild matches this platform, so these tools are
# installed unconditionally rather than detected at build time (Story 1.5 AC-30).
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/tsconfig/package.json ./packages/tsconfig/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/agent/package.json ./packages/agent/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY packages/tsconfig ./packages/tsconfig
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/crypto ./packages/crypto
COPY packages/agent ./packages/agent
COPY packages/eslint-config ./packages/eslint-config

WORKDIR /app
RUN pnpm --filter @project-vault/shared build \
 && pnpm --filter @project-vault/crypto build \
 && pnpm --filter @project-vault/db build \
 && pnpm --filter @project-vault/agent build \
 && pnpm --filter @project-vault/api build
```

`docker-compose.yml`'s `migrate` service targets this entire stage just to run one command:

```19:32:docker-compose.yml
  # One-shot migration runner: creates the vault_app role, RLS policies, and triggers
  # (see packages/db/src/migrations/0001_rls_and_triggers.sql) before `api` starts, so
  # `api` never has to connect as the postgres superuser (AC-1b — superuser bypasses RLS).
  migrate:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
      target: builder
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-password}@db:5432/${POSTGRES_DB:-project_vault}
    command: ["pnpm", "--filter", "@project-vault/db", "db:migrate"]
    depends_on:
      db:
        condition: service_healthy
```

**Corrected fact (2026-07-09 adversarial review caught this — the original story draft's claim
below was empirically wrong and is kept here, struck through, as a record of the mistake rather
than silently rewritten):**

~~`db:migrate` needs only `shared`+`db`, not `crypto`/`agent`/`api`: `packages/db/package.json`'s
`db:migrate` script is `tsx src/scripts/guarded-migrate.ts`. That script's only local imports are
`../lib/migration-safety.js` and `@project-vault/shared`... schema/type-definition files never
touched by `guarded-migrate.ts`.~~ **This reasoning is correct for the `tsx`-executed
`guarded-migrate.ts` *runtime* import graph, but wrong for what actually needs to happen first:**
`docker-compose.yml`'s `migrate` service runs `pnpm --filter @project-vault/db db:migrate` inside
the **built** `db-builder` image, and getting there requires `pnpm --filter @project-vault/db
build` to succeed — a full `tsc` compile of `packages/db/src/**` (per `packages/db/tsconfig.json`,
which has no exclusions for individual files), not just `guarded-migrate.ts`'s own import graph.
That `tsc` compile type-checks **every** file in `src/`, including `schema/pending-imports.ts` and
`schema/credential-versions.ts`, both of which `import type { EncryptedValue } from
'@project-vault/crypto'` — and `packages/db/package.json` formally lists `@project-vault/crypto` as
a `dependency` (not a devDependency), confirming this isn't accidental. **Verified empirically:**
running `pnpm --filter @project-vault/db build` in a build context containing only
`shared`+`db`'s built output (no `crypto`) fails with `TS2307: Cannot find module
'@project-vault/crypto'`. **`db-builder` must therefore build `crypto` too** — `shared` → `crypto`
→ `db`, in that dependency order. This still avoids building `agent` and `api` (2 of 5 packages),
which is a smaller saving than the original "3 of 5" claim but is the actual correct, buildable
scope. See AC-D1's corrected `RUN` below.

**Why NOT the fully-standalone "minimal migrate image" alternative:** the Dockerfile's own comment
on the `deploy` stage already documents a **previously-attempted and abandoned** version of exactly
that idea:

```38:47:apps/api/Dockerfile
# Bundle the api and its production deps into a self-contained directory. This runs in its
# own stage (not in `builder`) because `pnpm deploy` prunes the workspace node_modules to
# production-only in place — the `migrate` service targets `builder` directly to run
# drizzle-kit, and a pruned workspace there made pnpm's automatic deps-status check try to
# self-heal via `pnpm install --production`, which fails on the root `prepare: husky` script
# (a devDependency absent from a production install).
# pnpm deploy copies from the already-built virtual store (argon2 native binary included)
# so no compiler toolchain is needed in the runner stage.
FROM builder AS deploy
RUN pnpm --filter @project-vault/api deploy --prod --legacy /app/deploy
```

A bespoke "copy only `packages/db`'s migration files + a minimal Node+drizzle-kit runtime" image
(this story's option (a)) would need either a pruned/deployed workspace (already documented above
as broken for this exact use case) or a from-scratch `package.json` outside the pnpm workspace
entirely (bigger surface area, no precedent in this repo, and does not obviously save the dominant
cost anyway — see next paragraph). **Decision: option (b), a lower-risk build-layer split**, not a
bespoke image.

**What the split fix actually saves (be honest about what it doesn't):** `pnpm install
--frozen-lockfile` (line 21) always installs the *entire* workspace's dependencies regardless of
which packages are later `--filter`-built, because `--frozen-lockfile` requires the lockfile and
on-disk workspace to match exactly — this is the same constraint that makes the "bespoke image"
option risky (previous paragraph). `argon2`'s native compile (the single slowest step, needing
`python3 make g++`) happens during **this** `pnpm install` step for every consumer of the workspace,
not during `crypto`'s own `tsc build` — so splitting stages does **not** avoid the argon2 compile
time, and (per the corrected fact above) `db-builder` must build `crypto` anyway since `db`'s
schema files import its types. What it **does** avoid: the `tsc build` time for `agent` and `api`
only (2 of 5 package builds, not 3 — corrected from the original draft's miscount) when only
`migrate` needs to be built, **and** it decouples `migrate`'s build success from unrelated
`agent`/`api` TypeScript errors — today, a broken `apps/api` build (e.g. a bad merge) blocks
`migrate` from building at all, even though migrations have nothing to do with `apps/api`'s source.
This is a smaller win than originally scoped, but still real: `api` is typically the largest and
slowest single `tsc` unit of the five (most source files, most dependents), so skipping it alone
is likely the majority of the original problem's actual wall-clock cost — verify this assumption
empirically at implementation time (e.g. time each `pnpm --filter build` individually) rather than
taking this story's estimate on faith.

**Compose files that reference the `builder` target (verified via repo-wide grep — exhaustive
list, nothing else references it):**

- `docker-compose.yml` line 26 (`migrate` service) — **retargeted to `db-builder` by this story.**
- `docker-compose.dev.yml` lines 6-9 (`api` service, dev hot-reload via `pnpm dev` + a bind mount)
  — **left targeting `builder`, unaffected**, since `builder` still ends up containing everything
  it does today (just split across two stages/`RUN`s instead of one).
- `docker-compose.prod.yml` — no `build:`/`target:` overrides at all; inherits `docker-compose.yml`'s
  `api`/`web` services unchanged (those don't specify `target:`, so they always build through to the
  final `runner` stage regardless of this story).
- `.github/workflows/ci.yml`'s `docker-build` job (lines 173-238) builds `apps/api/Dockerfile` with
  no `target:` override either (defaults to the last stage, `runner`) — unaffected.
- `apps/api/src/__tests__/deployment-hardening.test.ts` — asserts on `USER node`, the runner stage's
  `postgresql16-client` install, and other **content**, never on stage **names** — unaffected by
  adding a new intermediate stage.

### Group P — the already-shipped `check-story-status-sync` check

**Read this before doing anything else in Group P — the check P6-1 describes already exists.**
`deferred-work.md`'s P6-1 row (`§ "Open (Epic 6 retro)"`) and this story's own `sprint-status.yaml`
comment both describe P6-1 as *unimplemented* ("no automated check catches story-file `Status:`
header vs `sprint-status.yaml` drift"). Direct code inspection during this story's creation found
this is **stale** — the check was already built and shipped:

```bash
$ git log --oneline -- scripts/check-story-status-sync.ts
dc42f4a feat(ci): build story-status-sync check (retro P6-1/P7-1/P8-1)
```

`scripts/check-story-status-sync.ts` (105 lines) exists today, fully implements P6-1's exact ask —
scans every `_bmad-output/implementation-artifacts/<key>.md` file's `Status:` header, compares
against `sprint-status.yaml`'s `development_status[<key>]`, and fails with a clear per-file diff:

```79:100:scripts/check-story-status-sync.ts
function report(mismatches: StatusMismatch[]): void {
  if (mismatches.length === 0) {
    process.stdout.write(
      'check-story-status-sync: every story file Status: header matches sprint-status.yaml — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: story file `Status:` header does not match sprint-status.yaml (P6-1/P7-1/P8-1 drift):\n'
  )
  for (const m of mismatches) {
    process.stderr.write(
      `  - ${m.storyFile}: file says "Status: ${m.storyStatus}", sprint-status.yaml says "${m.sprintStatus}"\n`
    )
  }
  ...
}
```

— and it is **already wired into both gates**:

```109:118:Makefile
ci: ## Full local quality gates (needs Postgres: make db-up or make bootstrap first)
	pnpm turbo typecheck
	pnpm turbo lint
	$(MAKE) db-migrate
	$(MAKE) check-rls
	$(MAKE) check-audit-actor-token-coverage
	pnpm check-search-index
	pnpm check-migration-compatibility
	pnpm check-story-status-sync
	pnpm check-psc-tbd-tracking
```

```99:101:.github/workflows/ci.yml
      - name: Check story status sync (retro P6-1/P7-1/P8-1)
        run: pnpm check-story-status-sync
```

Its own test suite (`scripts/check-story-status-sync.test.ts`) already includes a real-repository
assertion (`scanStoryStatusSync(process.cwd())` must return `[]`) that passes today against every
currently-committed story file. **Do not re-implement this check or write a second one** — that
would be exactly the "reinventing wheels" mistake this workflow's own instructions warn against.
P6-1's *code* is done. What is genuinely still missing, and what Group P's ACs below actually
close, is: (1) traceability from the generic fixture tests to the specific named historical
incidents the check's own doc comment already references, and (2) proof this story doesn't become
drift incident #6.

**Note for whoever next touches `deferred-work.md`** (out of scope for this story to edit — the
task that produced this story file was explicitly instructed not to touch `deferred-work.md`):
its P6-1 row and this story's own `sprint-status.yaml` comment should eventually be corrected to
say "implemented, hardening only" rather than "no automated check exists" — flagging this here so
it isn't lost.

### Group T — tag storage and case (in)sensitivity

Tags are stored as a plain JSONB string array on both tables — **no relational tag table, no
unique index, no `citext`, no DB-level case folding at all**:

```26:31:packages/db/src/schema/credentials.ts
    description: text('description'),
    // tags stored as a JSONB string array; search/management lands in Story 2.3.
    tags: jsonb('tags')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
```

`packages/db/src/schema/projects.ts` has an identical `tags: jsonb('tags')...` column. Every
comparison — dedup, delta, and filter — happens in application code, and every one of them is
exact-string (case-sensitive) today:

```1:10:apps/api/src/lib/tags.ts
export function dedupeTags(tags: string[]): string[] {
  return tags.filter((tag, index) => tags.indexOf(tag) === index)
}

export function tagDelta(oldTags: string[], newTags: string[]) {
  return {
    added: newTags.filter((tag) => !oldTags.includes(tag)),
    removed: oldTags.filter((tag) => !newTags.includes(tag)),
  }
}
```

```81:100:apps/api/src/modules/credentials/service.ts
function parseTagFilter(rawTags: string | undefined): string[] {
  return (rawTags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}
...
  const tagList = parseTagFilter(params.query.tags)
  if (tagList.length > 0) {
    filters.push(sql`${credentials.tags} @> ${JSON.stringify(tagList)}::jsonb`)
  }
```

**Exhaustive list of every call site that needs to change** (verified via repo-wide grep for
`dedupeTags`, `tagDelta`, `parseTagFilter` — nothing else calls any of these three functions):

- `apps/api/src/modules/credentials/service.ts` line 315 (`dedupeTags` inside
  `updateCredentialTags`, used by both the `PUT`/replace and `PATCH`/append credential-tags routes)
  and line 329 (`tagDelta`).
- `apps/api/src/modules/projects/routes.ts` line 558 (`dedupeTags` inside the `PUT
  /:projectId/tags` handler) and line 568 (`tagDelta`).
- `apps/api/src/modules/credentials/service.ts` line 97 (`parseTagFilter`, feeding the `GET
  /credentials?tags=` list filter).

**Existing test fixtures already happen to use lowercase tags** (`PAYMENTS_TAG = 'payments'`,
`PROD_TAG = 'prod'` in `credentials/routes.test.ts`; `TEAM_PAYMENTS_TAG = 'team-payments'`,
`TIER_0_TAG = 'tier-0'` in `projects/routes.test.ts`/`projects/schema.test.ts`) — normalizing to
lowercase changes **zero** existing test expectations. `TagArrayBodySchema`
(`apps/api/src/modules/credentials/schema.ts` lines 79-84) only trims and length-bounds; it does
not case-fold, and this story does not need to change the schema itself (see AC-T1 — normalization
happens once, downstream, in `dedupeTags`, which both mutation routes already funnel through).
`apps/api/src/modules/credentials/import-service.ts` (bulk import) always sets `tags: []` on
created credentials (line 217) — bulk import never accepts user-supplied tags today, so there is no
fourth call site hiding there.

**Data migration is required** (existing rows may already contain mixed-case tags, e.g. from before
this story): the next unused migration number is `0043` as of 2026-07-09
(`packages/db/src/migrations/0042_*.sql` is the latest today) — but see the Project Structure Notes'
cross-story coordination callout: two sibling stories also claim `0043`, so this may need to be
`0044` or `0045` at actual implementation time. A plain `UPDATE ... SET tags = (SELECT jsonb_agg(DISTINCT lower(elem)) FROM
jsonb_array_elements_text(tags) elem)` is **not** a destructive statement under
`findDestructiveStatements`'s definition (`packages/db/src/lib/migration-safety.ts`) — that scanner
only flags `DROP *` statements and `ADD COLUMN ... NOT NULL` without a `DEFAULT`, never plain
`UPDATE` — so this migration will apply automatically via `guarded-migrate.ts` with no
`--allow-destructive` flag needed.

### Group C — `placeholder-copy.ts` and its (zero) real callers

```1:34:apps/web/src/lib/components/shell/placeholder-copy.ts
// Story 6.3 Task 8: 'health' removed — /health now renders the real cross-project health
// dashboard instead of a placeholder, so its old "arrives in Epic 6" copy no longer applies.
// Story 9.7 AC-T1: 'settings' removed — has zero live callers in apps/web/src/routes; keeping
// unreachable dead code is worse than removing it (retro Finding 7 / Action Item A9-4).
export type PlaceholderSectionKey = 'projects' | 'credentials'

export type PlaceholderSectionCopy = {
  title: string
  copy: string
}

const placeholderSections: Record<PlaceholderSectionKey, PlaceholderSectionCopy> = {
  projects: {
    title: 'Projects',
    copy: 'No projects are saved yet. Project persistence arrives in Story 2.1.',
  },
  credentials: {
    title: 'Credentials',
    copy: 'Choose a project to manage credentials.',
  },
}

export function getPlaceholderSections() {
  return placeholderSections
}

export function getPlaceholderSection(key: PlaceholderSectionKey) {
  switch (key) {
    case 'projects':
      return placeholderSections.projects
    case 'credentials':
      return placeholderSections.credentials
  }
}
```

`deferred-work.md`'s "Stale copy" bullet claims only the `projects` key's copy is stale and only the
`credentials` key is fully unused ("gateway page is real"). **Direct re-verification during this
story's creation found this is only half right** — a repo-wide grep for every possible consumer
(`getPlaceholderSection`, `getPlaceholderSections`, `PlaceholderSection`, `placeholder-copy`, `shell/
placeholder`) across all of `apps/web/src` turns up exactly three files, and no others:

1. `apps/web/src/lib/components/shell/placeholder-copy.ts` (the module itself)
2. `apps/web/src/lib/components/shell/PlaceholderSection.svelte` (its **only** consumer — imports
   `getPlaceholderSection` and renders `copy.title`/`copy.copy`)
3. `apps/web/src/routes/placeholder-sections.test.ts` (a unit test of `getPlaceholderSections`,
   testing the module in isolation)

**`PlaceholderSection.svelte` itself has zero importers anywhere in `apps/web/src/routes`** (nor
anywhere else in `apps/web/src/lib`) — confirmed via grep across every `.svelte` file in the app.
Every real route (`/dashboard`, `/projects`, `/projects/[projectId]/credentials`, etc.) has long
since been replaced by real implementations (Stories 2.0, 2.1, 2.2 and onward); nothing left ever
renders `<PlaceholderSection section="projects">` or `<PlaceholderSection section="credentials">`.
**Both keys are dead code today, not just `credentials`** — the same "unreachable dead code" class
Story 9.7 AC-T1 already used to justify removing `settings`, and Story 6.3 used to justify removing
`health`. This story finishes that same cleanup for the two keys that were left behind.

---

## Acceptance Criteria

### Group D — Split the `migrate` build off the full API `builder` stage

**AC-D1 — New `db-builder` stage builds `@project-vault/shared`, `@project-vault/crypto`, and
`@project-vault/db` (three packages — corrected from an earlier "shared+db only" draft after
adversarial review found it does not build; see the corrected-fact note above).**
**Given** `apps/api/Dockerfile`'s existing `pnpm install --frozen-lockfile` step and the full
`COPY apps/api ./apps/api` / `COPY packages/... ./packages/...` block (lines 9-30, unchanged),
**When** a new stage is inserted immediately after that `COPY` block,
**Then** it is named `db-builder`, and its only `RUN` is:
```dockerfile
FROM builder AS db-builder
RUN pnpm --filter @project-vault/shared build \
 && pnpm --filter @project-vault/crypto build \
 && pnpm --filter @project-vault/db build
```
`@project-vault/crypto` is required here — NOT skippable — because `packages/db/tsconfig.json`
compiles all of `src/**` with no per-file exclusions, and two schema files
(`schema/pending-imports.ts`, `schema/credential-versions.ts`) `import type { EncryptedValue }
from '@project-vault/crypto'`; omitting `crypto`'s build causes `pnpm --filter @project-vault/db
build` to fail with `TS2307: Cannot find module '@project-vault/crypto'` (verified empirically
during this story's adversarial review — do not skip re-verifying this at implementation time if
`packages/db`'s schema files change).
(Renaming: the *existing* first stage, currently named `builder` and containing the
`apk add`/`COPY`/`pnpm install` steps, keeps that exact name and content unchanged up through the
final `COPY packages/eslint-config` line — `db-builder`'s `FROM builder` simply extends it. Do not
rename the first stage; only add `db-builder` as a new stage after it.)

**Example (positive):** `docker build --target db-builder -f apps/api/Dockerfile .` succeeds and
produces an image containing `packages/shared/dist/`, `packages/crypto/dist/`, and
`packages/db/dist/`, but **not** `packages/agent/dist/` or `apps/api/dist/` (those directories do
not exist in this stage's filesystem — verify with `docker run --rm <image> ls packages/agent`
failing with "No such file or directory").

**Example (edge — build order):** `pnpm --filter @project-vault/shared build` must run before
`pnpm --filter @project-vault/crypto build`, which must run before `pnpm --filter
@project-vault/db build`, all in the same `RUN` (via `&&`, matching the existing file's ordering
convention and its existing `shared → crypto → db → agent → api` sequence) — `@project-vault/crypto`
depends on `@project-vault/shared`, and `@project-vault/db` depends on both, per each package's
`package.json` `dependencies`, so building out of order fails with a missing `dist/`.

**Example (negative — confirms the corrected reasoning, do not regress to the original draft):**
`docker build --target db-builder` with the `RUN` reverted to only `shared`+`db` (the original,
incorrect AC-D1 draft) fails with `TS2307: Cannot find module '@project-vault/crypto'` during the
`db` build step — this is the exact failure the adversarial review reproduced; if implementation
somehow re-introduces this, it is a regression, not a valid alternative approach.

---

**AC-D2 — The final `builder` stage (used by `api`/`web`) is renamed to avoid a name collision and
extends `db-builder`, building only the two remaining packages.**
**Given** AC-D1 introduces a stage literally named `db-builder`,
**When** the *existing* final-assembly stage (today also named `builder`, containing the 5-package
`RUN`) is updated,
**Then** it is renamed `builder` still (keep the name — `docker-compose.dev.yml` line 8 and any
other `target: builder` reference must keep working with zero compose-file changes beyond AC-D3),
but its `FROM` line changes from the base image digest to `FROM db-builder`, and its `RUN` drops
the now-redundant `shared`/`crypto`/`db` builds:
```dockerfile
FROM db-builder AS builder
RUN pnpm --filter @project-vault/agent build \
 && pnpm --filter @project-vault/api build
```
(Because `db-builder` already has `shared`+`crypto`+`db` built by AC-D1, and BuildKit stages are
strictly additive/cumulative, `builder`'s final filesystem after this `RUN` contains all 5
packages' `dist/` — byte-for-byte identical to today's single 5-line `RUN`, just produced across
two stages instead of one.)

**Example (positive — end-to-end equivalence):** `docker build --target builder -f
apps/api/Dockerfile .` (today, one `builder` stage) and the post-AC-D1/D2 two-stage
`db-builder`→`builder` chain produce images with identical `packages/*/dist/` and `apps/api/dist/`
contents (same files, same compiled output) — verify by diffing `docker run --rm <image> find
/app -name '*.js' -path '*/dist/*' | sort | md5sum` before/after this change is a poor comparison
(build timestamps embedded in comments/sourcemaps may differ trivially); instead verify by
confirming `pnpm --filter @project-vault/api build` still succeeds identically and produces the
same `.js` files with the same exports (a `tsc` compile is deterministic given identical source).

**Example (edge — `deploy`/`runner` stages untouched):** `FROM builder AS deploy` (existing, line
46) and everything after it in the Dockerfile requires **zero** changes — `builder`'s final
filesystem is unchanged by this split, only the path to get there changed.

---

**AC-D3 — `docker-compose.yml`'s `migrate` service targets `db-builder`, not `builder`.**
**Given** `docker-compose.yml` lines 22-32 (the `migrate` service),
**When** this story lands,
**Then** line 26 changes from `target: builder` to `target: db-builder` — no other line in the
`migrate` service block changes (same `context`, same `dockerfile`, same `environment`, same
`command`, same `depends_on`).

**Example (positive):** `docker compose build migrate` (cold, no cache) no longer runs `pnpm
--filter @project-vault/agent build` or `pnpm --filter @project-vault/api build` at all — verify
via `docker compose build migrate 2>&1 | grep -c '@project-vault/'` showing exactly 3 filtered
builds (`shared`, `crypto`, `db`), not 5.

**Example (regression — the migrate command itself is untouched):** `docker compose run --rm
migrate` still runs `pnpm --filter @project-vault/db db:migrate` (line 29, unchanged) against a
running `db` service and applies pending migrations exactly as before — including this story's own
new migration 0043 (AC-T4).

---

**AC-D4 — Regression: `docker-compose.dev.yml`'s dev `api` service (still targeting `builder`)
and the production `api`/`web` images (via `runner`, no `target:` override) are unaffected.**
**Given** `docker-compose.dev.yml` lines 6-9 (`target: builder`, `command: ["pnpm", "dev"]`) and
`docker-compose.yml`'s `api`/`web` services (no `target:`, defaulting to the Dockerfile's last
stage, `runner`),
**When** AC-D1/AC-D2 land,
**Then** `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build api` still
builds successfully and starts `pnpm dev` against a `builder`-stage image containing all 5 built
packages (unchanged — `builder` still has everything, per AC-D2), and `docker compose build api`
(production path, `runner` stage) still produces a working image passing its existing `HEALTHCHECK`
(`curl -f http://localhost:3000/health`).

**Example (regression, must not change):** `apps/api/src/__tests__/deployment-hardening.test.ts`'s
existing assertions (`USER node` in both Dockerfiles, `postgresql16-client` in the runner stage,
`docker-compose.yml` not exposing Postgres on `0.0.0.0`, `.dockerignore` contents) all still pass
unmodified — none of them reference stage *names*, only stage *content*, which is unchanged.

---

**AC-D5 — Regression: no other script or Make target references the `builder` stage name or
assumes `migrate` and `api` share exactly one build stage.**
**Given** a repo-wide search for `target: builder` and `apps/api/Dockerfile` (already performed
during this story's creation — matches: `docker-compose.yml` (fixed by AC-D3),
`docker-compose.dev.yml` (unaffected per AC-D4), `.github/workflows/ci.yml`'s `docker-build` job
(no `target:`, unaffected), and prose-only mentions in other story files' Dev Notes),
**When** `make bootstrap-docker` (→ `scripts/operator-bootstrap.sh --docker`, which runs `docker
compose up --build -d` with no target overrides of its own) or `make docker-up`/`make docker-smoke`
(→ `docker compose up --build -d` / `pnpm docker:smoke`) are run against this story's Dockerfile,
**Then** they succeed end-to-end exactly as before — `scripts/operator-bootstrap.sh` and the
`Makefile` needed **zero** line changes for this story (verified: neither file mentions `builder`
or any stage name at all; they only ever invoke `docker compose up`/`docker compose exec`, which
resolve stage targets purely from `docker-compose.yml`, already fixed by AC-D3).

**Example (positive — full smoke path):** `make bootstrap-docker` on a machine with no prior Docker
build cache completes successfully, `curl -sf http://localhost:${API_HOST_PORT:-3000}/health`
returns 200, and the `migrate` container's logs show a `MIGRATION_APPLIED`
(`OperationalEvent.MIGRATION_APPLIED`) structured log line listing migration `0043` (once AC-T4
exists) among the applied set.

---

### Group P — Harden the already-shipped story-status-sync check

> **Read the Background section above first — P6-1's check already exists and is already wired
> into `make ci` + CI. Do not re-implement `check-story-status-sync.ts`.** This group's ACs are
> deliberately small: verification + traceability + dogfooding, not new detection logic.

**AC-P1 — Verification baseline: the existing check passes today, unmodified, before any of this
story's other groups touch tracked files.**
**Given** `scripts/check-story-status-sync.ts` and its test file exist and are wired into `make ci`
(Makefile line 117) and `.github/workflows/ci.yml` (lines 99-100),
**When** `pnpm check-story-status-sync` and `pnpm vitest run scripts/check-story-status-sync.test.ts`
are run at the start of this story's implementation,
**Then** both exit `0` — the check reports `check-story-status-sync: every story file Status:
header matches sprint-status.yaml — OK` and all existing tests (including the real-repository
assertion `scanStoryStatusSync(process.cwd())` → `[]`) pass. This is a **regression gate for this
story's own other three groups**: if Group T's migration or Group C's file deletion accidentally
touches an unrelated story file's `Status:` header, this AC's re-run at the end of implementation
(Task 4 below) would catch it.

**Example (regression, must not change):** re-running the same two commands after Groups D/T/C are
implemented (but before Group P's own new tests are added) still exits `0` with the identical `OK`
message — none of this story's other work touches any `Status:` header or `sprint-status.yaml`
entry other than this story's own (which AC-P3 covers explicitly).

---

**AC-P2 — Traceability: name the fixture tests after the specific historical incidents the check's
own doc comment already references, so a future refactor of the parser can see exactly which real
recurrences it must keep catching.**
**Given** `scripts/check-story-status-sync.ts`'s own header comment already says *"P6-1/P7-1/P8-1
— the same drift ... has been caught by manual retro sweeps three epics running"*, and
`deferred-work.md`/`sprint-status.yaml`'s `last_updated` history separately name three concrete
past incidents — CP4-4 (Epic 4 retro, 2026-07-03: all four Epic 4 story files' `Status:` headers
out of sync with `done`), A6-3 (Epic 6 retro, 2026-07-06: 6-1/6-2/7-1/7-2/7-3/8-1 headers stuck at
`review` while sprint-status already said `done`), and the Epic 8 "5th recurrence" (8-7, caught
during its own post-implementation code review) —
**When** `scripts/check-story-status-sync.test.ts` gains three new, explicitly-named test cases (in
addition to, not replacing, the existing generic ones),
**Then** each new test constructs a fixture reproducing that specific incident's exact shape (e.g.
the CP4-4 case: a fixture story file with `Status: review` while `sprint-status.yaml` says `done`
for that same key, in a `describe` block or `it` title literally containing `"CP4-4"`) and asserts
`scanStoryStatusSync` catches it — proving the current implementation (not just a conceptually
similar generic case) actually catches each real historical shape, not merely something adjacent to
it.

**Example (positive — CP4-4 shape):** fixture `sprint-status.yaml` has `4-1-team-invitations-and-
role-assignment: done`; fixture story file `4-1-team-invitations-and-role-assignment.md` has
`Status: review` → `scanStoryStatusSync` returns one mismatch for that key with
`storyStatus: 'review'`, `sprintStatus: 'done'`.

**Example (positive — A6-3 shape, multiple simultaneous mismatches):** fixture sprint-status marks
three keys `done`; fixture story files for those same three keys all say `Status: review` →
`scanStoryStatusSync` returns exactly three mismatches, one per key, each correctly attributed
(not conflated into a single generic error).

---

**AC-P3 — Dogfooding: this story's own file and `sprint-status.yaml` entry never drift, at every
status transition.**
**Given** this story file (`1-13-infra-and-process-hardening.md`) is set to `Status: ready-for-dev`
and `sprint-status.yaml`'s `1-13-infra-and-process-hardening` key is set to `ready-for-dev` in the
same change (Task 4 / Story Completion below),
**When** `pnpm check-story-status-sync` runs after this story is saved,
**Then** it reports `OK` with this story's own key included among the scanned files and showing no
mismatch — and this AC's intent (documented here for whoever transitions this story's status next)
is that the **same command must be re-run and pass** at every subsequent transition
(`ready-for-dev` → `in-progress` → `review` → `done`), matching P3 in
`_bmad-output/implementation-artifacts/product-surface-contract.md` ("Story file `Status:` must
match `sprint-status.yaml` for the same story key" on every transition).

**Example (positive):** immediately after this story file is created, `pnpm check-story-status-sync`
exits 0 and its stdout does not mention `1-13-infra-and-process-hardening` at all (no mismatch is
reported for a key that matches).

**Example (edge — the thing this AC prevents):** if a future session flips this story's `Status:`
header to `in-progress` without also updating `sprint-status.yaml` (or vice versa), the very next
`make ci` run fails with a line naming this file specifically — this is P6-1's entire purpose,
applied reflexively to the story that hardens it.

---

### Group T — Normalize tag case on write and on filter

**AC-T1 — `dedupeTags` normalizes every tag to lowercase before deduplicating, so mixed-case
duplicates collapse to one entry.**
**Given** `apps/api/src/lib/tags.ts`'s current case-sensitive `dedupeTags`,
**When** a new `normalizeTag(tag: string): string` function (`return tag.toLowerCase()`) is added
and `dedupeTags` is rewritten to map every tag through it before the existing index-based dedup
check,
**Then** `dedupeTags(['Prod', 'PROD', 'staging'])` returns `['prod', 'staging']` (first-occurrence
order preserved, using the *normalized* value for the "first occurrence" comparison — so `'Prod'`
at index 0 wins the position, but the stored/returned value is lowercase `'prod'`, not the original
casing).

**Example (positive):** `dedupeTags(['Prod', 'prod', 'Staging'])` → `['prod', 'staging']` (2
entries, not 3).

**Example (edge — already-normalized input, regression):** `dedupeTags(['payments', 'prod'])` →
`['payments', 'prod']` (unchanged output for already-lowercase input — matches every existing test
fixture in `credentials/routes.test.ts`/`projects/routes.test.ts`, none of which need updating).

**Example (edge — empty array):** `dedupeTags([])` → `[]` (unchanged behavior).

---

**AC-T2 — `parseTagFilter` normalizes filter tags to lowercase, so `GET
/credentials?tags=Prod` matches credentials stored (post-AC-T1/AC-T4) as `prod`.**
**Given** `apps/api/src/modules/credentials/service.ts`'s `parseTagFilter` (lines 81-86), which
today only trims and drops empty segments,
**When** each parsed tag is additionally lowercased (via the same `normalizeTag` from AC-T1, imported
from `../../lib/tags.js`) before being returned,
**Then** the JSONB containment filter built at line 99
(`sql\`${credentials.tags} @> ${JSON.stringify(tagList)}::jsonb\``) only ever compares against
lowercase values — consistent with every stored tag after AC-T1 (new writes) and AC-T4 (existing
rows, backfilled).

**Example (positive):** a credential stored with `tags: ['prod']` (either written after AC-T1, or
backfilled by AC-T4) is returned by `GET /credentials?tags=Prod` (mixed-case query param) —
today, before this fix, it is not.

**Example (edge — multiple comma-separated tags, mixed case):** `?tags=Prod,Payments` parses to
`['prod', 'payments']`, and the containment filter requires the credential to have **both** (JSONB
`@>` semantics, unchanged) — case-normalization does not change the AND-vs-OR semantics of the
existing filter, only the casing of what's compared.

---

**AC-T3 — Regression: `tagDelta`'s added/removed comparison stays correct once its inputs are
consistently normalized upstream.**
**Given** `tagDelta(oldTags, newTags)` (`apps/api/src/lib/tags.ts` lines 5-10) is **not itself
modified** by this story — it stays a plain case-sensitive `.includes()` comparison,
**When** its two callers (`credentials/service.ts` line 329, `projects/routes.ts` line 568) continue
to pass it `row.tags`/`current.tags` (raw DB read) as `oldTags` and the `dedupeTags(...)`-normalized
result as `newTags`,
**Then** because AC-T4's migration guarantees every pre-existing DB row's tags are already
lowercase, and AC-T1 guarantees every new write is lowercase, `oldTags` and `newTags` are always
both-lowercase by the time `tagDelta` runs — so no change to `tagDelta` itself is needed, and a
regression test proves the case that used to be a bug is now a no-op: `tagDelta(['prod'],
dedupeTags(['Prod']))` → `{ added: [], removed: [] }` (previously, before AC-T1, this would have
incorrectly reported `{ added: ['Prod'], removed: ['prod'] }` — a phantom diff for what is
semantically the same tag).

**Example (positive — the bug this closes):** replacing a credential's tags from `['prod']` to
`['Prod']` via `PUT .../tags` now produces an audit payload (`credentials/service.ts`'s
`auditPayload`) with `added: []`, `removed: []`, `resultCount: 1` — not a spurious
add-one/remove-one delta for a tag that, semantically, didn't change at all.

**Example (edge — a genuine change alongside a case-only one):** replacing `['prod', 'legacy']`
with `['Prod', 'staging']` produces `added: ['staging'], removed: ['legacy']` — `prod`/`Prod`
correctly does not appear in either list (no real change), while the genuine `legacy`→`staging`
swap is still reported.

---

**AC-T4 — New migration backfills existing `credentials.tags`/`projects.tags` to lowercase and
dedupes any resulting collisions.**
**Given** rows written before this story may already contain mixed-case tags (e.g. `['Prod']` or
`['Prod', 'prod']` on the same row, both currently valid),
**When** a new migration `packages/db/src/migrations/0043_normalize_tag_case.sql` is added (next
sequential number after `0042_platform_audit_retention_purge.sql`) containing:
```sql
UPDATE "credentials"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE "tags" <> (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
);--> statement-breakpoint
UPDATE "projects"
SET "tags" = (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
)
WHERE "tags" <> (
  SELECT coalesce(jsonb_agg(DISTINCT lower(elem)), '[]'::jsonb)
  FROM jsonb_array_elements_text("tags") AS elem
);
```
**Why the `WHERE` clause compares against the normalized result, not just `<> '[]'::jsonb`
(corrected during 2026-07-09 adversarial review):** both `credentials` and `projects` have a
`set_updated_at BEFORE UPDATE` trigger (`0014_credentials.sql`, `0013_projects.sql`), so any `UPDATE`
that touches a row — even one that ends up writing back the exact same value — bumps that row's
`updated_at`. A naive `WHERE tags <> '[]'::jsonb` would rewrite (and bump `updated_at` on) every
tagged row in the database, including rows whose tags were already lowercase and deduped, which is
an unnecessary, unaddressed side effect an earlier draft of this AC missed. The corrected `WHERE`
clause only matches rows whose current `tags` value actually differs from its normalized form, so
already-compliant rows are left completely untouched (no `UPDATE`, no `updated_at` bump, no
trigger fire) and only genuinely mixed-case/duplicate rows are touched — which is the only
`updated_at` bump this migration can honestly justify (the row's persisted data is, in fact,
changing).
(register it via `drizzle-kit generate`'s normal journal update, or hand-add the
`meta/_journal.json` entry following the existing entries' exact shape — see any prior migration
for the pattern),
**Then** every existing row's `tags` array is lowercase and duplicate-free after migration, rows
that were already compliant have their `updated_at` and all other columns completely untouched,
and `guarded-migrate.ts`'s destructive-statement scan (`findDestructiveStatements`) does **not**
flag either `UPDATE` statement (plain `UPDATE ... SET ... WHERE ...` matches none of
`migration-safety.ts`'s `SIMPLE_PATTERNS` — no `DROP`, and no `ADD COLUMN ... NOT NULL` without
`DEFAULT`), so this migration applies automatically via `make bootstrap`/`make docker-up`'s
`migrate` service with no `--allow-destructive` flag.

**Example (positive):** a row with `tags: ['Prod', 'prod', 'Staging']` before migration has
`tags: ['prod', 'staging']` after (order from `jsonb_agg(DISTINCT ...)` is not guaranteed to match
input order — acceptable, since tag order was never a documented contract anywhere in the schema or
API responses; only tag *set membership* is meaningful).

**Example (edge — a row with `tags: []`):** normalizing `[]` yields `[]`, so the `WHERE` clause's
equality check is false — skipped entirely, no-op, no `UPDATE`, no `updated_at` bump.

**Example (edge — a row already all-lowercase, no duplicates):** `tags: ['prod']` normalizes to
`['prod']` — identical to the current value, so the `WHERE` clause's equality check is false and
this row is **not** touched at all: no `UPDATE`, no `updated_at` bump, no trigger fire. This is the
corrected behavior (see the `WHERE`-clause rationale above) — the large majority of rows in
practice are expected to already be lowercase-only, so this matters for avoiding a mass
unnecessary `updated_at` bump across the database.

**Example (regression — a row that genuinely needs normalizing does get its `updated_at` bumped,
and this is accepted, not a bug):** a row with `tags: ['Prod']` is rewritten to `tags: ['prod']`
by this migration, and — because its data genuinely changed — `set_updated_at` correctly bumps its
`updated_at` to the migration's execution time. This is a one-time, honest side effect of a real
data correction (not the mass-rewrite the corrected `WHERE` clause avoids for unaffected rows) and
does not need any special handling — a consumer that treats `updated_at` as "last time this row's
data changed" is not misled by it.

---

**AC-T5 — Regression: the full existing `apps/api` test suite passes unmodified after AC-T1
through AC-T4 (no existing test's expectations change).**
**Given** every existing tag-related test fixture already uses lowercase tag strings
(`PAYMENTS_TAG = 'payments'`, `PROD_TAG = 'prod'`, `THIRD_PARTY_TAG = 'third-party'` in
`credentials/routes.test.ts`; `TEAM_PAYMENTS_TAG = 'team-payments'`, `TIER_0_TAG = 'tier-0'` in
`projects/routes.test.ts` and `projects/schema.test.ts`; `'payments'`/`'third-party'`/`'prod'` in
`credentials/schema.test.ts`),
**When** AC-T1 through AC-T4 land,
**Then** none of these existing tests need any expectation changed — `pnpm --filter
@project-vault/api test` and `pnpm --filter @project-vault/db test` both remain fully green with
zero modified assertions in any pre-existing test file (only new test cases are added, per AC-T6).

**Example (regression, must not change):** `credentials/routes.test.ts`'s existing "PATCH
credential tags appends as a set union and enforces post-merge bounds" test (`PAYMENTS_TAG,
PROD_TAG` → append `THIRD_PARTY_TAG, PAYMENTS_TAG` → expect `[PAYMENTS_TAG, PROD_TAG,
THIRD_PARTY_TAG]`) passes byte-for-byte identically, since all three constants are already
lowercase.

---

**AC-T6 — New end-to-end test: a mixed-case tag submitted via the real HTTP routes is stored,
returned, and filtered as lowercase.**
**Given** the real `PUT`/`PATCH /api/v1/projects/:projectId/credentials/:credentialId/tags` and
`PUT /api/v1/projects/:projectId/tags` routes,
**When** a new integration test (added to `credentials/routes.test.ts` and
`projects/routes.test.ts` respectively, following each file's existing
`createTestCredential`/`updateCredentialTags` helper patterns) submits `tags: ['Prod', 'PROD',
'Staging']`,
**Then** the response body's `tags` field is `['prod', 'staging']` (2 entries, lowercase, in that
order), a subsequent `GET .../credentials?tags=prod` (or the project-tags equivalent) includes that
resource, and a subsequent `GET .../credentials?tags=Prod` (mixed-case query) **also** includes it
(AC-T2).

**Example (positive — credentials):** `PUT .../tags` with `{ tags: ['Prod', 'prod'] }` → `200 {
data: { id, tags: ['prod'] } }`; `GET /credentials?tags=PROD` on the same project → the credential
appears in `data.items`.

**Example (positive — projects):** `PUT /projects/:id/tags` with `{ tags: ['Team-Payments'] }` →
`200 { data: { id, tags: ['team-payments'] } }`.

---

### Group C — Remove dead `placeholder-copy.ts`/`PlaceholderSection.svelte`

**AC-C1 — Documented finding: both remaining placeholder keys are unreachable dead code today
(broader than `deferred-work.md`'s claim that only `credentials` is unused).**
**Given** a repo-wide grep across all of `apps/web/src` for every symbol exported by
`placeholder-copy.ts` (`getPlaceholderSection`, `getPlaceholderSections`, `PlaceholderSectionKey`)
and for every `.svelte` file importing `PlaceholderSection.svelte`,
**When** this story's implementation re-runs that same grep (already performed during story
creation — see Background),
**Then** it confirms exactly three files reference any of this: the module itself, its sole
component consumer (`PlaceholderSection.svelte`), and its own isolated unit test
(`placeholder-sections.test.ts`) — zero routes under `apps/web/src/routes` import
`PlaceholderSection.svelte`, so **both** the `projects` and `credentials` keys are dead, not just
`credentials`.

**Example (positive — the verification command):**
```bash
grep -rl "PlaceholderSection\|placeholder-copy\|getPlaceholderSection" apps/web/src
```
returns exactly: `apps/web/src/lib/components/shell/placeholder-copy.ts`,
`apps/web/src/lib/components/shell/PlaceholderSection.svelte`,
`apps/web/src/routes/placeholder-sections.test.ts` — no `+page.svelte` or other route file appears.

---

**AC-C2 — Delete the module, its component, and its test in full — not a partial edit.**
**Given** AC-C1's finding that all three files exist solely to support each other with no external
caller,
**When** this story is implemented,
**Then** all three files are deleted outright:
- `apps/web/src/lib/components/shell/placeholder-copy.ts`
- `apps/web/src/lib/components/shell/PlaceholderSection.svelte`
- `apps/web/src/routes/placeholder-sections.test.ts`

matching the precedent already set by Story 9.7 AC-T1's removal of the `settings` key ("keeping
unreachable dead code is worse than removing it") — this story finishes that cleanup for the two
keys 9.7 and 6.3 left behind, rather than editing the `projects` blurb's stale "Story 2.1" text in
place (editing dead code that renders nowhere would fix nothing observable and just delay the
inevitable follow-up deletion).

**Example (positive):** after this change, `apps/web/src/lib/components/shell/` no longer contains
`placeholder-copy.ts` or `PlaceholderSection.svelte`, and `apps/web/src/routes/` no longer contains
`placeholder-sections.test.ts`.

---

**AC-C3 — Regression: typecheck, lint, and build stay green with no other file referencing the
removed exports.**
**Given** deleting a file that some other, missed caller still imports would surface as a
typecheck/build failure (SvelteKit's `$lib` alias resolution + `tsc`/`vite build` both fail loudly
on a missing module),
**When** AC-C2's deletions land,
**Then** `pnpm --filter @project-vault/web typecheck`, `pnpm --filter @project-vault/web lint`, and
`pnpm --filter @project-vault/web build` (and the full `apps/web` test suite) all pass with zero
errors — this is the natural safety net for a dead-code deletion of this kind (the same safety net
Story 9.7 relied on for its own `settings`-key removal; no new "unused file" static-analysis rule is
introduced by this story, since none exists elsewhere in this codebase for this class of check and
inventing one would be scope beyond a hygiene cleanup).

**Example (positive — the regression this proves):** if some route the grep in AC-C1 missed had
actually imported `PlaceholderSection.svelte`, `pnpm --filter @project-vault/web build` would fail
with a Vite/Rollup "could not resolve" error immediately, not silently ship a broken page — proving
the deletion is safe precisely because the build stays green.

---

## Tasks / Subtasks

Follow this project's TDD convention (`AGENTS.md`): write/extend the failing test first, confirm it
fails for the expected reason, then implement, per AC. The four groups are independent — implement
in any order, or split across separate PRs, per this story's own framing.

- [ ] **Task 1 — Group D: split the migrate Docker build (AC-D1 through AC-D5)**
  - [ ] 1.1 Edit `apps/api/Dockerfile`: insert the new `db-builder` stage building
    `shared`+`crypto`+`db` (AC-D1) and retarget the existing final stage to `FROM db-builder AS
    builder` with the trimmed 2-package (`agent`+`api`) `RUN` (AC-D2).
  - [ ] 1.2 Edit `docker-compose.yml` line 26: `target: builder` → `target: db-builder` (AC-D3).
  - [ ] 1.3 Run `docker compose build migrate` and `docker compose build api` (or `make docker-up`)
    against a clean/no-cache build; confirm both succeed and `migrate`'s build log shows only
    `shared`+`crypto`+`db` `pnpm --filter` invocations (AC-D3's example command).
  - [ ] 1.4 Run `pnpm --filter @project-vault/api test -- deployment-hardening` (or the full
    `apps/api` suite) to confirm `deployment-hardening.test.ts` is unaffected (AC-D4).
  - [ ] 1.5 Run `make bootstrap-docker` (or `make docker-smoke`) end-to-end at least once to confirm
    AC-D5's full-stack regression.

- [ ] **Task 2 — Group P: harden the story-status-sync check (AC-P1 through AC-P3)**
  - [ ] 2.1 Run `pnpm check-story-status-sync` and `pnpm vitest run
    scripts/check-story-status-sync.test.ts` now, before touching anything else, to establish the
    AC-P1 baseline (expect: both green).
  - [ ] 2.2 RED: add the three new named historical-incident test cases to
    `scripts/check-story-status-sync.test.ts` (CP4-4, A6-3, "5th recurrence" shapes per AC-P2) using
    the existing `useFixtureRoots`/`writeFixture` helpers already imported in that file. Since the
    check's underlying logic already handles the generic case, these should pass immediately on
    first run — if any fails, that is itself a genuine bug in the shipped checker to fix (fold that
    fix into this task rather than treating "already passes" as a foregone conclusion).
  - [ ] 2.3 Confirm AC-P3 by re-running `pnpm check-story-status-sync` once this story file's
    `Status:` header and `sprint-status.yaml` entry are both set (Task 4).

- [ ] **Task 3 — Group T: tag case normalization (AC-T1 through AC-T6)**
  - [ ] 3.1 RED: add unit tests for `normalizeTag`/`dedupeTags` to a new
    `apps/api/src/lib/tags.test.ts` (no such file exists today — follow the sibling
    `apps/api/src/lib/*.test.ts` convention, e.g. `pagination.test.ts`, for style) covering AC-T1's
    examples. Run, confirm failure (function doesn't lowercase yet).
  - [ ] 3.2 GREEN: add `normalizeTag` and rewrite `dedupeTags` in `apps/api/src/lib/tags.ts`
    (AC-T1).
  - [ ] 3.3 RED: add a `tagDelta` regression test to the same new file for AC-T3's
    "case-only change is a no-op delta" example. Run, confirm it already passes once 3.2 lands
    (this AC requires no change to `tagDelta` itself — the test documents *why* it doesn't need one).
  - [ ] 3.4 RED: extend `credentials/service.test.ts` if one exists, or add inline coverage in
    `credentials/routes.test.ts`, for `parseTagFilter`'s new lowercasing (AC-T2). Confirm failure.
  - [ ] 3.5 GREEN: update `parseTagFilter` in `apps/api/src/modules/credentials/service.ts` to map
    through `normalizeTag` (AC-T2).
  - [ ] 3.6 Write migration `packages/db/src/migrations/0043_normalize_tag_case.sql` (AC-T4) and its
    `meta/_journal.json` entry via `pnpm --filter @project-vault/db generate` (preferred — let
    drizzle-kit register it) or by hand, matching existing entries' shape exactly.
  - [ ] 3.7 RED: add the AC-T6 end-to-end HTTP tests to `credentials/routes.test.ts` and
    `projects/routes.test.ts`. Confirm failure against pre-3.2/3.5 code (re-check against a git
    stash if 3.2/3.5 already landed) or confirm they pass post-implementation.
  - [ ] 3.8 Run the full `apps/api` and `packages/db` suites; confirm AC-T5 (zero pre-existing test
    changes needed) and AC-T6 (new tests green).
  - [ ] 3.9 Run `make db-migrate` (or `make bootstrap`) against a DB with pre-existing mixed-case
    tag data (seed one manually if the local dev DB has none) to manually verify AC-T4's backfill
    end-to-end at least once.

- [ ] **Task 4 — Group C: remove dead placeholder-copy code (AC-C1 through AC-C3)**
  - [ ] 4.1 Re-run AC-C1's grep command; confirm the three-file result set matches this story's
    Background section exactly (catches any drift since this story was written).
  - [ ] 4.2 Delete `apps/web/src/lib/components/shell/placeholder-copy.ts`,
    `apps/web/src/lib/components/shell/PlaceholderSection.svelte`, and
    `apps/web/src/routes/placeholder-sections.test.ts` (AC-C2).
  - [ ] 4.3 Run `pnpm --filter @project-vault/web typecheck`, `lint`, `build`, and the full `apps/web`
    test suite; confirm all green (AC-C3).

- [ ] **Task 5 — Full verification and story completion**
  - [ ] 5.1 Run `make ci` (or the equivalent full local gate) green, covering all four groups
    together — typecheck/lint/db-migrate/check-rls/check-story-status-sync/tests/jscpd/etc.
  - [ ] 5.2 Set this story's `Status:` header (already `ready-for-dev` from creation) forward through
    its normal lifecycle as work proceeds, keeping `sprint-status.yaml`'s
    `1-13-infra-and-process-hardening` key in sync at every transition (AC-P3, P3 in
    `product-surface-contract.md`).
  - [ ] 5.3 Do **not** edit `deferred-work.md`'s P6-1 row, D4 row, tag-case row, or "Stale copy"
    bullet as part of implementing this story — per this story's own creation constraints, those
    are reconciled in a separate pass; leave a note in this story's Dev Agent Record instead if
    something material changes (e.g. AC-T4's migration number, once actually generated).

---

## Dev Notes

- **This story's four groups are deliberately independent.** Do not add cross-group imports,
  shared helper files, or a unifying "infra hardening" abstraction — that would be exactly the kind
  of speculative unification this grab-bag story structure is designed to avoid (unlike, say, Story
  9-8, whose two groups shared a persona and a root cause).
- **Group P is verification/hardening, not implementation** — see Background. Spending implementation
  time trying to build `check-story-status-sync.ts` from scratch would be a wasted, redundant effort;
  the only real work is AC-P2's three named regression tests and AC-P3's dogfooding confirmation.
- **Group T's normalization point is deliberately singular** (`dedupeTags`, called from both
  mutation routes) rather than pushed into the Zod schema (`TagArrayBodySchema`) — this keeps the
  change to one function plus one filter-parsing function, rather than touching schema validation
  that other, unrelated call sites might also depend on for non-normalization reasons (e.g. length
  bounds). Do not additionally lowercase in the schema layer — that would double-normalize
  harmlessly but adds a second point of truth for no benefit.
- **Group T's migration order does not matter relative to Group T's code changes** — the migration
  (AC-T4) fixes existing rows; the code changes (AC-T1/AC-T2) prevent new mixed-case rows. Either
  can land first in a split-PR scenario; landing the migration without the code change (or vice
  versa) is safe, just incompletely effective until both are in.
- **Group C's deletion has no migration/data implication** — this is pure dead frontend code with
  no backing data, unlike Group T.
- **Group D's Dockerfile edit is purely structural** — if a reviewer diffs the final `builder`
  stage's *effective* build steps before/after, they should be identical in total (just split
  across two stages). `db-builder` needs `crypto` too, not just `shared`+`db` (see AC-D1's
  corrected-fact note — `packages/db`'s schema files import `crypto`'s types, so omitting it
  breaks the `db` build). If a future package is added to the workspace and needs to be excluded
  from `db-builder`, add it to the `builder`-stage `RUN` (post-`db-builder`) only if `packages/db`
  never imports from it (verify with a grep for the new package's name inside `packages/db/src`
  before assuming it's excludable, exactly as this story had to for `crypto`) — `db-builder` should
  stay as minimal as `packages/db`'s actual compile-time dependency graph allows, not smaller.

### Project Structure Notes

- No new packages, no new top-level directories. Group T adds one new file
  (`apps/api/src/lib/tags.test.ts`) and one new migration
  (`packages/db/src/migrations/0043_normalize_tag_case.sql` + its journal entry). Group C removes
  three existing files, adds none. Groups D and P touch only existing files.
- **Migration numbering — cross-story coordination (do not skip):** as of 2026-07-09, TWO sibling
  stories from the same reconciliation batch *also* target migration index 43:
  `3-5-credential-expiry-notification-delivery` (`0043_credential_expiry_alerts.sql`) and
  `4-5-fine-grained-permissions-and-project-rbac` (`0043_project_membership_visibility_backfill.sql`).
  All three stories were drafted in parallel worktrees and none reserves the number. Whichever of
  1-13/3-5/4-5 is implemented (and merged to `main`) **first** keeps `0043`; the second keeps
  whatever the real next free number is at that time (likely `0044`); the third similarly takes the
  next free number after that (likely `0045`). Confirm `packages/db/src/migrations/meta/_journal.json`'s
  actual highest `idx` at implementation time — `ls packages/db/src/migrations/*.sql | sort | tail -1`
  — before writing this story's migration file, and renumber the file name, the `--> statement-breakpoint`
  tag, and every in-file reference to "0043" in this story accordingly if it is not actually free.

### References

- [Source: `_bmad-output/implementation-artifacts/deferred-work.md` §§ "Open (Epic 1 retro)" D4,
  "Deferred from: Epic 6 retrospective (2026-07-06)" § "Open (Epic 6 retro)" P6-1, "Security &
  permissions" tag-case row, "Shell placeholders" "Stale copy" bullet]
- [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-13-infra-and-process-
  hardening` entry comment, `last_updated` history (CP4-4, A6-3, "5th recurrence")]
- [Source: `apps/api/Dockerfile`; `docker-compose.yml`; `docker-compose.dev.yml`;
  `docker-compose.prod.yml`; `Makefile`; `scripts/operator-bootstrap.sh`]
- [Source: `scripts/check-story-status-sync.ts`, `.test.ts`; `.github/workflows/ci.yml` lines
  99-101; `Makefile` line 117]
- [Source: `apps/api/src/lib/tags.ts`; `apps/api/src/modules/credentials/service.ts`;
  `apps/api/src/modules/credentials/schema.ts`; `apps/api/src/modules/projects/routes.ts`;
  `packages/db/src/schema/credentials.ts`, `schema/projects.ts`;
  `packages/db/src/lib/migration-safety.ts`; `packages/db/src/scripts/guarded-migrate.ts`]
- [Source: `apps/web/src/lib/components/shell/placeholder-copy.ts`,
  `PlaceholderSection.svelte`; `apps/web/src/routes/placeholder-sections.test.ts`]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-
  contract.md`]

## Dev Agent Record

### Agent Model Used

TBD

### Debug Log References

### Completion Notes List

### File List
