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
