# Sprint Change Proposal - MVP Frontend Shell

**Project:** Project Vault  
**Date:** 2026-06-26  
**Change scope:** Moderate backlog resequencing  
**Status:** Approved for planning artifact update

## 1. Issue Summary

Project Vault is deep in Epic 1 foundation work: deployment, database, vault initialization, authentication, sessions, MFA/security controls, readiness, and operational logging. This work remains necessary, but the current delivery sequence delays meaningful UI validation until Epic 2.1, creating a risk that the team builds substantial infrastructure before testing whether evaluators understand the core product model.

The specific concern is MVP validation timing. The product needs earlier visible proof that users understand vault readiness, login, project-centric organization, empty dashboard states, and the first path toward storing credentials.

## 2. Impact Analysis

### Epic Impact

- **Epic 1:** No scope reduction or completion criteria change. Security-critical backend work remains the priority.
- **Epic 2:** Add a new bridge story before Story 2.1: `Story 2.0: MVP Frontend Shell & Empty Project Dashboard`.
- **Story 2.1:** Remains responsible for durable project creation and cross-project dashboard API behavior. Story 2.0 may use a minimal reusable project API subset or an explicitly labeled temporary stub.
- **Future epics:** No sequencing changes to Epics 3-9.

### Artifact Impact

- `_bmad-output/planning-artifacts/epics.md` updated with Story 2.0 and Epic 2 guardrails.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` updated with the new backlog story.
- PRD and UX specification do not require immediate changes because the PRD already includes early alpha validation principles and the UX spec already emphasizes project-centric structure, empty states, and mobile-friendly web UX.

### Technical Impact

The frontend shell should wire to existing Epic 1 APIs where available:

- `GET /health`
- `GET /ready`
- `POST /api/v1/vault/init`
- `POST /api/v1/vault/unseal`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

Project APIs are not yet implemented. Story 2.0 must choose one path before development starts:

- Preferred: implement a minimal real `POST /api/v1/projects` and `GET /api/v1/projects` subset using the final schema and RLS model.
- Fallback: use an explicitly labeled in-memory/local preview stub that resets and cannot be mistaken for persisted behavior.

## 3. Recommended Approach

Use **Direct Adjustment**: add a new Story 2.0 at the Epic 1 to Epic 2 transition.

This preserves security-critical Epic 1 sequencing while reducing product-validation risk. The story is intentionally thin: it validates the evaluator journey and product mental model without pulling credential storage, alerts, health monitoring, rotation, machine users, or compliance into the frontend prematurely.

Effort estimate: Low to medium, depending on whether minimal real project APIs are included.  
Risk level: Medium, mostly around placeholder honesty and API churn.  
Recommended implementation path: include minimal real project list/create APIs only if they can cleanly become the first slice of Story 2.1.

## 4. Detailed Change Proposals

### Story Addition

Add:

`Story 2.0: MVP Frontend Shell & Empty Project Dashboard`

Purpose:

- Pull visible frontend progress forward.
- Validate the vault/login/project-centered evaluator path.
- Establish the authenticated SvelteKit layout and route-guard pattern.
- Render purposeful empty dashboard states without fake data.

### Epic 2 Guardrail Addition

Add an Epic 2 note that Story 2.0:

- Uses real Epic 1 APIs where available.
- May use a minimal reusable project API or explicit temporary stubs.
- Must not expand Epic 1.
- Must not imply unavailable credential, alert, or health capabilities are functional.

### Sprint Status Addition

Add:

`2-0-mvp-frontend-shell-and-empty-project-dashboard: backlog`

Epic 2 remains `backlog` until a story file is created or implementation begins.

## 5. Implementation Handoff

### Development Team

- Implement Story 2.0 after Epic 1 auth/session/vault contracts are stable enough for frontend wiring.
- Keep session handling aligned with the architecture: `HttpOnly` cookies only; no localStorage/sessionStorage token persistence.
- Use honest placeholder states and avoid demo data that looks like real product state.

### Product Owner / Scrum Master

- Treat this as a backlog insertion, not an Epic 1 scope expansion.
- Keep Story 2.1 as the durable project API/dashboard story.
- Confirm before implementation whether Story 2.0 uses minimal real project APIs or temporary preview stubs.

### Success Criteria

The inserted story succeeds when a real evaluator can say:

> I understand what this product is, I can log in, I can see where projects live, and I know where my first secret will go.

## 6. Checklist Status

- [x] Trigger and context understood.
- [x] Epic impact assessed.
- [x] PRD/architecture/UX artifact conflicts reviewed.
- [x] Direct adjustment selected.
- [x] Story and sprint-status updates applied.
- [!] Implementation path decision remains before development: minimal real project API vs explicit temporary stub.
