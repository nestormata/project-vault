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
