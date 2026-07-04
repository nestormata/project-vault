# AGENTS.md

## Development Story Implementation

When implementing a development story, always use TDD red-green:

1. Write or update the tests first so they describe the intended behavior.
2. Run the focused tests and confirm they fail for the expected reason.
3. Implement the smallest code change needed to make those tests pass.
4. Re-run the focused tests and relevant broader checks until they pass.

Do not implement story behavior before creating the tests that prove it.

## Story Planning and Review

Before planning, reviewing, or implementing a story, look for contradictions across the PRD,
epics, architecture, prior story decisions, and current implementation. If requirements conflict,
pause to reconcile the intended behavior instead of layering compatibility shims over an unclear
contract.

When creating or reviewing acceptance criteria, explicitly cover the tricky paths: tenant/RLS
context, audit behavior and failure handling, auth/session lifecycle, concurrency or replay,
rate limits, migrations and runtime schema compatibility, operational logging/metrics, and
deployment hardening where relevant.

Prefer making cross-story dependencies explicit in the story notes. Call out what the story relies
on, what it intentionally defers, and which later epic or story must consume the behavior.

For future epics, run a planning-readiness pass before implementation starts. Use it to find stale
statuses, missing validation, ambiguous security requirements, and acceptance criteria that do not
exercise high-risk paths.

## Product Surface Contract (Epic 2 retro — mandatory)

Full rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

1. **G1 — Every story declares surface scope** (`api` / `web` / `both` / `none`). API-only work
   requires a linked UI story or honest-placeholder AC before `done` — never silent deferral.
2. **G2 — Epic completion gate** — no epic `done` while PRD user journeys are API-only without
   tracked UI follow-up or documented honest partial delivery.
3. **G3 — Navigation & dashboard truth** — new links must resolve; no hardcoded counts when backing
   data exists; security CI guards ship in `make ci` the same story.
4. **G4 — Persona journey** — user-facing stories include a persona journey stub; QA verifies
   before `done`.
5. **P3 — Status sync** — story file `Status:` must match `sprint-status.yaml` on every transition.

## Docker port isolation (multiple worktrees in parallel)

`docker-compose.yml` publishes the db/api/web host ports from `DB_HOST_PORT` / `API_HOST_PORT` /
`WEB_HOST_PORT` (`.env`, defaults 5432/3000/5173 — see `.env.example`). Two worktrees (or a
worktree plus a standalone test stack) using the same defaults will collide on the host: whichever
`docker compose up` runs second fails to bind and is unreachable, while `docker compose ps` still
looks fine — a confusing failure mode. Container/volume/network names are already isolated
per-worktree (Compose namespaces them by directory name), so **ports are the only thing that
needs active management**.

Before running any Docker command in this repo (`docker compose up`, `make docker-up`,
`make bootstrap-docker`, `make docker-smoke`, or a manual `docker compose ...`), or immediately
after hitting a port-bind failure:

```bash
make check-ports   # reports OK/BUSY for DB_HOST_PORT/API_HOST_PORT/WEB_HOST_PORT
make fix-ports      # auto-bumps any busy port to the next free one and writes .env
```

`make docker-up`, `make docker-smoke`, and `scripts/operator-bootstrap.sh` (used by
`make bootstrap-docker`) already run the fix automatically — you don't need to call it separately
before those. Call `make fix-ports` yourself before a bare `docker compose up`/`up -d`, and again
any time a port conflict appears mid-session (e.g. another worktree started its stack after yours).

`make test`, `make db-migrate`, `make check-rls`, and `make stryker` read `DB_HOST_PORT` from
`.env` automatically, so once `.env` has the right port those commands keep working against the
same stack without extra flags. `.env` is git-ignored — each worktree keeps its own.
