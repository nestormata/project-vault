# Story 14.0: Establish AGPLv3 License and Contributor Agreement

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a project maintainer preparing to build a commercial hosted SaaS extension on top of the open-source core,
I want the repository's licensing formally completed — a real AGPLv3 copyright notice, documented contribution governance, and an automated CLA enforcement mechanism — before any Extension API work ships,
so that self-hosters can freely use and modify Project Vault, external contributions can legally be folded into the closed-source SaaS extension, and a competitor forking the code to run a competing paid hosted service is deterred by AGPLv3's network-copyleft disclosure requirement.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `none` |
| **Evaluator-visible** | no |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | N/A — pure internal/governance story: no application code, no UI, no API. Rationale: this story's only "users" are external GitHub contributors interacting with GitHub's own PR interface (CLA bot comment, required status check), not Project Vault's product surface. Nothing here changes what a self-hosted operator or end user sees or can do with the running application. |

## Acceptance Criteria

**Copyright holder resolved with the user 2026-07-23: "Nestor Mata Cuthbert" (individual, not a company/entity). Use this exact name in AC1's notice — no longer an open question.**

1. **LICENSE notice is filled in, not generic boilerplate.**
   The repository already has a `LICENSE` file at the root containing the complete, unmodified AGPLv3 v3 legal text (661 lines) — confirmed during story creation. However its own "How to Apply These Terms to Your New Programs" section (lines 621–644) still contains the **unfilled template placeholders**:
   ```
   <one line to give the program's name and a brief idea of what it does.>
   Copyright (C) <year>  <name of author>
   ```
   **Positive example (what "done" looks like):** the placeholder lines are replaced with a real notice, e.g.:
   ```
   Project Vault — self-hosted secrets and credentials management platform
   Copyright (C) 2026  Nestor Mata Cuthbert
   ```
   placed in the LICENSE file's own header area (or a new top-of-file `NOTICE` block, whichever this repo's existing convention favors — there is no existing precedent, so either is acceptable as long as it's discoverable) — **not** buried only in a source file docstring.
   **Edge case:** do **not** modify the substantive license body (lines 1–620, the actual AGPLv3 legal terms) — this story only fills in the notice/attribution placeholder, it does not alter license terms.
   **Failure condition:** an AC review that finds `<year>` or `<name of author>` still literally present anywhere in the repo fails this AC — **and so does a placeholder-shaped stand-in** (e.g. `TBD`, `[Owner]`, `Project Vault Contributors` used only to unblock the story without actually resolving the open question below). The open question must be answered with a real name/entity before this AC can pass, not worked around.

2. **`package.json`'s `license` field is set.**
   Root `package.json` currently has **no** `"license"` field (confirmed during story creation via `grep -n '"license"' package.json` returning nothing).
   **Positive example:** add `"license": "AGPL-3.0-or-later"` (the correct SPDX identifier for AGPLv3-or-later; use `"AGPL-3.0-only"` instead if the intent is to NOT permit "or later" versions — confirm which with the user if ambiguous, default to `-or-later` matching the LICENSE file's own standard FSF text which permits later versions).
   **Verification:** `node -p "require('./package.json').license"` prints the SPDX string, not `undefined`.

3. **`CONTRIBUTING.md` exists and documents the CLA requirement with the SaaS-use disclosure.**
   No `CONTRIBUTING.md` exists in the repo today (confirmed during story creation).
   **Must include, at minimum:**
   - How to contribute (branch/PR workflow — can be brief, this repo's actual dev workflow is documented elsewhere; link to it rather than duplicating)
   - An explicit statement that a CLA must be signed before any external PR can be merged
   - **The disclosure clause is not optional**: contributions may be used by the project maintainer in a closed-source commercial SaaS product, separate from the open-source AGPLv3 codebase. This must be stated plainly, in the same document a contributor reads before opening a PR — not buried only in the CLA's own legal text. [Source: prd.md § Licensing & Contribution Model — "The dual-use intent is disclosed transparently in the CLA text"]
   - A one-line clarification that the CLA governs **contributions back to this repo only** — it does not restrict what anyone does with their own self-hosted deployment or fork (prevents a self-hoster from misreading the CLA as a usage restriction on the AGPLv3 code itself).
   - **When the CLA requirement becomes visible (added on review):** state plainly, near the top of `CONTRIBUTING.md` (before the workflow steps), that CLA signing happens at first-PR time via the automated bot — not before someone starts writing code. A contributor shouldn't have to hunt through the document to learn when the friction hits.
   - **No de-minimis exception in v1 (added on review, explicit scope decision not a gap):** even a trivial typo-fix PR requires a signed CLA — copyright attaches regardless of contribution size, and the sublicensing grant matters the same either way. This is a deliberate simplicity-over-convenience choice for v1, not an oversight; state it in `CONTRIBUTING.md` so a contributor submitting a one-line fix isn't surprised by the requirement.
   **Positive example (first-time contributor path):** a new contributor reads `CONTRIBUTING.md` before opening their first PR, understands both (a) they must sign a CLA and (b) their contribution may end up in a commercial product, before they've written any code.
   **Failure condition:** a `CONTRIBUTING.md` that mentions CLA signing but omits the SaaS-use disclosure fails this AC — the disclosure is the actual point (avoiding the MongoDB/Elastic-style "bait and switch" backlash the PRD explicitly flags as a risk to avoid), not just gating merges procedurally.

4. **The CLA document itself grants sublicensing rights broad enough for the SaaS extension, while keeping the outbound project AGPLv3.**
   A bare Developer Certificate of Origin (DCO — "I have the right to submit this under the project's license") is **insufficient** and must not be used as the sole mechanism — it does not grant the maintainer any relicensing/sublicensing right over contributions. [Source: prd.md § Licensing & Contribution Model, and the architecture research behind it: "a bare DCO is insufficient... recommend a CLA modeled on the Harmony Contributor Agreement or Apache-style CLA"]
   **The CLA text must state, at minimum:**
   - The project remains AGPLv3 forever for the contribution as merged into this repository (contributors are not granting away the open-source nature of their work)
   - Separately, the contributor grants the project maintainer a perpetual, broad license — including the right to sublicense — to use, modify, and distribute the contribution outside the AGPLv3 terms, including in closed-source/commercial products
   **Positive example:** a contributor who signs the CLA and later reads it again can correctly explain both halves of the deal — "my code stays open source in this repo AND the maintainer can also use it in their paid product" — without needing a lawyer to parse it.
   **Edge case — individual vs. entity contributors:** the CLA should have (or clearly note as a future addition if out of scope for v1) a path for both individual contributors and corporate contributors (where an employer might claim rights to an employee's contribution) — a bare individual CLA text can be adopted for this story if a corporate variant isn't yet needed, but this simplification must be stated explicitly as a documented scope decision, not silently omitted.
   **This story's deliverable is not legal advice** — the CLA text drafted here is a starting point requiring real attorney review before the project scales its contributor base, per prd.md's own explicit caveat. Add a one-line internal note (e.g., a code comment or a section in this story's Dev Notes) recording that attorney review is still pending — do not remove or "resolve" this caveat as part of implementation.

5. **CLA signature enforcement is automated as a required PR check — using a currently-maintained tool, not an abandoned one.**
   The most widely-known free CLA bot, `contributor-assistant/github-action`, was **archived and made read-only on 2026-03-23** (confirmed via web research during story creation) — do not use it or instruct users to sign in via the now-defunct hosted `cla-assistant.io` service. As of this story's creation, maintained forks exist (e.g. `SiliconLabsSoftware/action-cla-assistant`, `rdkcentral/contributor-assistant_github-action`) — **re-verify current maintenance status at implementation time** (this space moves fast) rather than trusting this story's snapshot, and prefer a fork that:
   - Runs as a self-contained GitHub Action (no dependency on a third-party hosted signature database — signatures stored in-repo or in a dedicated private signatures repo, consistent with this project's general preference for self-hosted/self-contained tooling over external SaaS dependencies)
   - Is pinned to an **exact commit SHA**, not a floating tag or branch ref — check `.github/workflows/*.yml` for this repo's existing Action-pinning convention (this repo already pins other third-party actions; match that pattern exactly) before adding the CLA action.
   **Positive example:** a first-time external contributor opens a PR; the bot posts a comment linking to the CLA with signing instructions; the PR's merge is blocked (required status check) until they sign; a returning contributor who already signed gets an automatic pass with no re-prompt.
   **Negative/edge cases:**
   - The repository owner's own PRs, and known bot accounts (e.g. `dependabot[bot]`), must be **excluded** from the CLA gate — verify the chosen action supports an allowlist/exclude-list and configure it, or the maintainer would be blocked from merging their own work.
   - A PR from a contributor who has already signed must not re-trigger the signing prompt.
   - If the CLA bot Action itself fails to run (e.g. GitHub Actions outage), the required-status-check should fail closed (block merge) rather than silently passing — verify this is the chosen action's default behavior; if not, this is a configuration item to set explicitly.
   - **Maintenance-rot safeguard (added on review):** this space is volatile — the most popular free option was already archived once (2026-03-23). Whichever fork is chosen, add a one-line note to `CONTRIBUTING.md` or a code comment in the workflow file recording *when* and *which* fork was selected, so a future maintainer checking "is this still the right choice" has a dated reference point instead of having to re-derive the research from scratch. This does not need to be a recurring check — just a discoverable timestamp.

6. **The CLA requirement is visible before a contributor opens a PR, not only after.**
   No `.github/pull_request_template.md` exists in this repo today (confirmed empty during story creation).
   **Add one** that includes a line pointing to `CONTRIBUTING.md`'s CLA section — so a first-time contributor sees the requirement while drafting their PR description, not only via a bot comment that arrives after submission.

7. **Verification checklist (run all of these before marking this story `review`):**
   - `grep -rn "<name of author>\|<year>  <name" LICENSE` returns **no matches**, **and** the notice contains a real, specific name/entity resolved via the Open Question below — not a generic placeholder-shaped stand-in like `TBD` or `Project Vault Contributors` (AC1)
   - `node -p "require('./package.json').license"` prints a real SPDX string (AC2)
   - `CONTRIBUTING.md` exists and contains both a CLA-required statement and the SaaS-use disclosure clause (AC3)
   - The CLA document text exists (as a linked file or embedded in the CLA bot's own configuration) and contains both the "stays AGPLv3" and "maintainer may sublicense for commercial use" clauses (AC4)
   - A test PR from a fresh, unsigned GitHub account is blocked from merging by the required CLA check, and a bot comment with signing instructions appears (AC5) — this is the one AC that requires live verification against the real GitHub repo, not just file inspection; document how it was verified (e.g. a screenshot or PR link) in the Dev Agent Record
   - `.github/pull_request_template.md` exists and references the CLA (AC6)

## Tasks / Subtasks

- [x] Task 1: Fill in LICENSE notice and package.json license field (AC: 1, 2)
  - [x] Resolve the copyright holder name/entity with the user (see Dev Notes Open Question) before editing
  - [x] Replace the two placeholder lines in LICENSE's "How to Apply" section with the real notice
  - [x] Add `"license": "AGPL-3.0-or-later"` to `package.json`
  - [x] Verify via the grep/node checks in AC7
- [x] Task 2: Write CONTRIBUTING.md and the CLA document (AC: 3, 4, 7)
  - [x] Draft CONTRIBUTING.md with contribution workflow, CLA requirement, and the mandatory SaaS-use disclosure clause
  - [x] Draft the CLA text itself (dual-clause: stays-AGPLv3 + maintainer-sublicensing-grant), stored as a linked document (e.g. `CLA.md` or wherever the chosen CLA bot expects it)
  - [x] Add the "not legal advice, attorney review pending" internal note
  - [x] Add the self-hosting-is-unrestricted clarification to CONTRIBUTING.md
- [x] Task 3: Wire up automated CLA enforcement (AC: 5)
  - [x] Research current maintenance status of CLA GitHub Actions (do not trust this story's snapshot — re-verify)
  - [x] Select a self-contained, actively-maintained action; pin to an exact commit SHA matching this repo's existing Action-pinning convention
  - [x] Configure owner/bot exclusion list
  - [ ] Configure as a required status check on the default branch — **NOT DONE**: requires GitHub repository branch-protection admin settings, which cannot be configured from within this git worktree/sandbox. Workflow file is ready; a repo admin must add "cla-check" as a required status check on `main` in GitHub's branch protection UI/API.
  - [x] Verify fail-closed behavior on Action failure (documented reasoning in workflow comments; GitHub reports a required check as failing when its producing job doesn't complete)
  - [ ] Open a real test PR from a throwaway/alt account (or documented equivalent) to confirm the gate actually blocks merge and the bot comment appears — **NOT DONE**: this requires live interaction with the real GitHub repo (a second account opening a PR against `nestormata/project-vault`), which is not achievable from this sandboxed environment. See Completion Notes.
- [x] Task 4: Add PR template referencing the CLA (AC: 6)
  - [x] Create `.github/pull_request_template.md` with a CLA-requirement line linking to CONTRIBUTING.md

## Dev Notes

- **This is a governance/legal-documentation story, not application code** — `Surface scope: none`. No `apps/api` or `apps/web` diff is expected. If a task here somehow requires touching application code, stop and flag it — that would mean the story's scope has drifted.
- **Copyright holder resolved (2026-07-23):** "Nestor Mata Cuthbert" — individual, not a company/entity. Use this exact name for AC1's LICENSE notice.
- Do not use `contributor-assistant/github-action` directly — confirmed archived 2026-03-23 during story creation. Re-verify fork maintenance status at implementation time regardless of what's listed in AC5; this research has a short shelf life.
- Cross-reference this repo's own recent precedent for "verify before trusting a snapshot" — the same discipline applied during this session's PRD/architecture work (multiple corrections were made after cross-checking claims against actual repo state rather than assumption).
- **Attorney review is explicitly out of scope for this story to obtain** — the deliverable is a solid, well-reasoned starting draft (per the architecture/PRD research already done), not a substitute for real legal review before the project scales its external contributor base. Do not remove this caveat when marking ACs complete.

### Project Structure Notes

- New files at repo root: `CONTRIBUTING.md`, `CLA.md` (or equivalent, per whichever CLA bot's expected location), `.github/pull_request_template.md`
- Modified files: `LICENSE` (notice section only), `package.json` (one field)
- New CI config: a `.github/workflows/*.yml` entry (or equivalent) for the CLA bot, following this repo's existing third-party-Action-pinning convention (check existing workflows — `ci.yml`, `nightly.yml`, `vault-action-release.yml`, etc. — for the exact pinning style already in use before adding a new one inconsistently)

### References

- [Source: prd.md § Licensing & Contribution Model] — the core license decision (AGPLv3), the CLA-not-DCO reasoning, the SaaS-use disclosure requirement, and the "not legal advice" caveat
- [Source: prd.md § Executive Summary / Key Differentiators] — "Extensible by design" differentiator this story's licensing work underpins
- [Source: architecture.md § Licensing & Contribution Model] — the architectural framing of why this story blocks the rest of Epic 14 (public-facing Extension API must not ship under a to-be-decided license)
- [Source: epics.md § Epic 14: Extension Architecture & Pluggable Authentication, Story 14.0] — this story's origin definition, epic-level rationale for sequencing it first
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- Verification checks (AC7) run RED (pre-implementation, all failing as expected) then GREEN (post-implementation, all passing) — see Completion Notes for exact output.
- CLA-action research: `gh api repos/contributor-assistant/github-action` confirmed `archived: true`, `pushed_at: 2026-03-23`. `gh api repos/rdkcentral/contributor-assistant_github-action` confirmed `archived: false`, `pushed_at: 2026-06-13`, tag `v2.7.0` at commit `2c505e3cbfadaa766a7dd6e00e9b22c26509c13c`. `gh api repos/SiliconLabsSoftware/action-cla-assistant` also non-archived but less recently pushed (2026-06-02); rdkcentral's fork chosen as the more recently active of the two.

### Completion Notes List

- **AC1 (LICENSE notice):** Replaced the two unfilled placeholder lines in LICENSE's "How to Apply These Terms" section (lines 632-633) with a real notice: `Project Vault — self-hosted secrets and credentials management platform` / `Copyright (C) 2026  Nestor Mata Cuthbert`. No other line in the 661-line legal body was touched (`git diff LICENSE` shows only these 2 lines changed). Matches the copyright line already present in README.md's existing License section, confirming consistency with prior precedent.
- **AC2 (package.json license field):** Added `"license": "AGPL-3.0-or-later"` to root `package.json`, matching the LICENSE file's own "or any later version" FSF standard text.
- **AC3 (CONTRIBUTING.md):** Created at repo root. States the CLA-at-first-PR-time-via-bot timing near the top (before the workflow steps), the SaaS-use disclosure clause in plain language, the self-hosting/forking-is-unaffected clarification, and the explicit no-de-minimis-exception scope decision. Links to README.md's existing dev-setup/CI sections rather than duplicating them. Also updated README.md's "Contributing" section (previously stated the project wasn't accepting external contributions) to reference the new CONTRIBUTING.md/CLA.md so the two documents don't contradict each other.
- **AC4 (CLA.md):** Created at repo root. Individual-contributor CLA with both required clauses (stays-AGPLv3-forever + separate perpetual/sublicensable grant for commercial/closed-source use), a "not legal advice, attorney review pending" notice that is explicitly preserved (not resolved away), and an explicit documented scope note that a corporate/entity CLA variant is a future addition, not built in v1.
- **AC5 (automated CLA enforcement):** Re-verified at implementation time via `gh api` (not trusting the story's snapshot) that `contributor-assistant/github-action` is archived (confirmed) and that `rdkcentral/contributor-assistant_github-action` is an actively maintained fork (non-archived, pushed 2026-06-13, tagged releases). Selected it, self-contained (in-repo signature storage, no third-party hosted DB), and pinned `.github/workflows/cla.yml` to the exact commit SHA `2c505e3cbfadaa766a7dd6e00e9b22c26509c13c` (tag `v2.7.0`) rather than a floating tag. Configured `allowlist: nestormata,dependabot[bot],dependabot-preview[bot]` to exclude the repo owner and known bots. Added a dated provenance comment in the workflow file per the story's maintenance-rot safeguard requirement.
  - **Note on this repo's existing Action-pinning convention:** contrary to the story's Dev Notes assumption ("this repo already pins other third-party actions" to exact SHA), inspection of all existing `.github/workflows/*.yml` files found every third-party Action (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `SonarSource/*`, `docker/*`, `aquasecurity/trivy-action`, etc.) pinned to a floating version tag or `@master`, not a SHA — and `.github/dependabot.yml` has a `github-actions` ecosystem entry, implying the existing convention relies on Dependabot to bump version tags, not SHA-pinning. AC5's own text still explicitly requires exact-SHA pinning for the CLA action regardless of what convention is found, so I followed AC5's explicit instruction over the (evidently stale) convention claim in Dev Notes — SHA-pinning is also the more defensible security choice for a less-trusted third-party fork. Flagging this discrepancy for review rather than silently reconciling it.
  - **NOT completed (documented, not silently skipped):** (a) configuring `cla-check` as a GitHub branch-protection *required* status check on `main` — this is a repo-admin action in GitHub's settings/API, not achievable from this sandboxed git worktree; the workflow is ready to be added once someone with admin access does so. (b) Live verification via a real test PR from a fresh/unsigned GitHub account confirming the bot comments and blocks merge — also not achievable from this sandboxed environment (no ability to open PRs against the live `nestormata/project-vault` GitHub repo from here). Both are explicitly called out as open follow-ups rather than claimed as done.
- **AC6 (PR template):** Created `.github/pull_request_template.md` with an explicit CLA section linking to both `CONTRIBUTING.md` and `CLA.md`.
- **AC7 (verification checklist):** All file-inspection checks re-run and passing after implementation:
  - `grep -rn "<name of author>\|<year>  <name" LICENSE` → no matches (was 1 match pre-implementation)
  - `node -p "require('./package.json').license"` → `AGPL-3.0-or-later` (was `undefined` pre-implementation)
  - `CONTRIBUTING.md` exists, contains CLA-required statement + SaaS-use disclosure
  - `CLA.md` exists, contains both the stays-AGPLv3 and sublicense-for-commercial-use clauses
  - `.github/pull_request_template.md` exists and references the CLA
  - The one AC7 item requiring live GitHub verification (test PR from an unsigned account) is the documented open item above — not claimed as done.
- **Scope check:** No `apps/api` or `apps/web` files were touched. Changed/added files are all governance/documentation/CI-config (LICENSE, package.json, README.md, CONTRIBUTING.md, CLA.md, `.github/pull_request_template.md`, `.github/workflows/cla.yml`), consistent with `Surface scope: none`.
- **Attorney review caveat:** preserved as an explicit open item in `CLA.md`'s header, per Dev Notes instruction not to remove it.

### File List

- `LICENSE` (modified — notice section only, lines 632-633)
- `package.json` (modified — added `license` field)
- `README.md` (modified — updated "Contributing" section to reference new CONTRIBUTING.md/CLA.md)
- `CONTRIBUTING.md` (new)
- `CLA.md` (new)
- `.github/pull_request_template.md` (new)
- `.github/workflows/cla.yml` (new)

### Change Log

- 2026-07-24: Implemented story 14-0 — filled AGPLv3 LICENSE notice and `package.json` license field, added `CONTRIBUTING.md` and `CLA.md`, wired up `rdkcentral/contributor-assistant_github-action` (SHA-pinned) as a CLA-enforcement GitHub Action, and added a PR template referencing the CLA. Status: ready-for-dev → review. Two AC5 sub-items (branch-protection required-check configuration; live test-PR verification) documented as not achievable from this sandboxed environment and left as explicit follow-ups for a repo admin.
- 2026-07-24: Code review (bmad-code-review, fresh context) verified the SHA pin against the live GitHub API (annotated tag `v2.7.0` dereferences to `2c505e3cbfadaa766a7dd6e00e9b22c26509c13c`, GPG-verified) and confirmed `contributor-assistant/github-action` is archived — both story claims held up. One high-severity finding fixed: `.github/workflows/cla.yml` had `branch: "main"` for signature storage, copied from the action's own example config — but that example's accompanying comment explicitly warns "branch should not be protected," and `gh api repos/nestormata/project-vault/branches/main/protection` confirms `main` **is** protected (required PR reviews). A direct push there would have been rejected, silently breaking signature persistence for every contributor. Changed to a dedicated `cla-signatures` branch; added a follow-up note (alongside the existing required-status-check item) for a repo admin to confirm/create that branch unprotected if the action doesn't auto-create it.
