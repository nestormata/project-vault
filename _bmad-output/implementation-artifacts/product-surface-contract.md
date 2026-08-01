# Product Surface Contract

**Origin:** Epic 2 retrospective (2026-06-30) — prevents API/UI gaps from surviving story completion.

**Applies to:** `create-story`, `dev-story`, `code-review`, `sprint-planning`, epic retrospectives.

---

## G1 — Product Surface Contract (per story)

Every story file **must** include a `## Product Surface Contract` section (see `bmad-create-story/template.md`).

| Surface scope | Meaning | Required before `done` |
|---------------|---------|------------------------|
| `api` | Backend/API only in this story | Linked UI story ID **or** honest-placeholder AC |
| `web` | Frontend only | Routes resolve; persona journey defined |
| `both` | API + web in same story | Full evaluator path + API tests |
| `none` | Internal (migration, CI, ops) | Rationale documented; no user-facing claims |

### API-only rules

- Never mark `done` with "frontend out of scope" and no follow-up.
- `Linked UI story` must be a real story key (e.g. `2-8-...`) or `TBD` with a blocking note — not blank.
- `Honest placeholder AC` must cite AC text if UI is deferred (e.g. AC-E2f empty state, not fake zeros).

### Web / both rules (G3)

- Search, onboarding, and nav links must resolve to real routes (no 404).
- Dashboard/list counts must query backing data when it exists — no hardcoded `0`.
- Security CI guards introduced in a story must land in `make ci` the same story.

### Persona journey (G4)

- User-facing stories need a **Persona journey** stub: who, steps, expected UI outcome.
- API-only with evaluator impact: journey describes honest empty/placeholder state.
- Pure internal stories: `N/A` with one-line rationale.

---

## G2 — Epic Completion Gate

An epic **must not** move to `done` in `sprint-status.yaml` until:

1. Every story in the epic is `done` (story file **and** sprint-status aligned).
2. Every PRD user journey for that epic is either:
   - Shipped in web UI, **or**
   - Documented partial delivery with honest placeholders, **or**
   - Explicitly deferred with a linked follow-up story still tracked in sprint-status.
3. Epic retrospective completed (`epic-N-retrospective: done`).
4. No open **Critical** product-surface gaps from retro action items.

**Enforced in:** `bmad-sprint-planning/checklist.md`, `bmad-retrospective` readiness step.

---

## G3 — Navigation & Dashboard Truth (definition of done)

Before story → `review`:

- [ ] New `goto` / href / GlobalSearch targets have matching SvelteKit routes
- [ ] Onboarding and wizard links resolve or show honest disabled state
- [ ] Aggregate counts (`credentialCount`, `expiringCount`, etc.) use real queries when tables are populated
- [ ] Placeholders follow AC-E2f: explicit empty/not-configured — never fabricated success states

---

## G4 — Persona journey at QA sign-off

Before story → `done` (after code review):

- [ ] Persona journey in story file is exercised manually or via test
- [ ] Viewer/member/admin role gates verified if story is role-sensitive
- [ ] API-only stories: evaluator path documented and honest

## G5 — Contextual input guidance

Every user-facing input, select, checkbox, and equivalent form control must have visible,
localized, plain-language explanatory text describing what it controls, why it matters, or what
trade-off it carries. The control must reference that explanation through `aria-describedby` (or an
equivalent accessible relationship). This applies to new and existing forms; a control must not be
omitted merely because its behavior seems self-explanatory to the implementer.

Before an epic can close, any existing controls found without this guidance must be fixed or have a
tracked follow-up story in `sprint-status.yaml`.

---

## P3 — Story status sync

On every status transition (`ready-for-dev` → `in-progress` → `review` → `done`):

- Story file `Status:` must match `sprint-status.yaml` for the same story key.
- Epic status updated only when **all** stories are `done` and G2 gate passes.

---

## Closure story pattern (safety net, not plan)

Story 2.8 demonstrated an acceptable **epic closure story** when gaps slip through:

- Scope derived from retro action items with traceability matrix
- Each retro finding maps to an AC
- Epic reopened to `in-progress` until closure story merges

Prefer G1–G4 so closure stories are rare.

**Open deferrals:** `_bmad-output/implementation-artifacts/deferred-work.md` § Epic 2 closure (2026-06-30).

---

## Quick reference for agents

```
create-story  → fill Product Surface Contract; validate in checklist §3.6
dev-story     → verify G3 + P3 before review; G4 before done
code-review   → Acceptance Auditor checks surface contract + navigation truth
sprint-plan   → G2 before epic-2: done
retrospective → G2 readiness + surface gap audit
```
