# Story 4.1: Team Invitations & Role Assignment

Status: backlog

<!-- Story stub created from Epic 1 retro P4 — full create-story workflow pending. Epics source: _bmad-output/planning-artifacts/epics.md#Story-4.1 -->

## Story

As a project owner or admin,
I want to invite users to my project by email and assign them a role,
so that teammates can access the credentials and assets they need with appropriate permissions.

*Covers: FR2, FR3, FR57 (invite gate)*

---

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes — invite flow in web UI + API |
| **Linked UI story** | same story (4.1) |
| **Honest placeholder AC** | N/A |
| **Persona journey** | See **MFA journey (FR57)** below |

---

## MFA journey (FR57) — Epic 1 retro P4

**Policy reference:** `_bmad-output/planning-artifacts/mfa-policy-matrix.md` — row *Owner/admin, MFA enrolled*.

**Persona:** Alex (project owner), MFA enrolled, grace period expired.

| Step | Action | Expected |
|------|--------|----------|
| 1 | `POST /auth/login` with password | `200 { mfaRequired: true, mfaToken }` — no session cookies |
| 2 | `POST /auth/mfa/verify-login` with valid TOTP | Full session cookies + `200 { userId, orgId }` |
| 3 | `POST /api/v1/projects/:projectId/invitations` | `201` invitation created |
| 4 | (negative) Unenrolled owner/admin after grace | `403 { code: "mfa_required" }` on invite — no invitation row |

**Regression dependency:** `apps/api/src/__tests__/mfa-journey.integration.test.ts` (steps 1–2 + privileged route) must stay green before this story closes.

**Integration tests must cover:** invite blocked without MFA enrollment; invite succeeds after full MFA login journey.

---

## Acceptance Criteria (from epics — implement in create-story)

See `_bmad-output/planning-artifacts/epics.md` Story 4.1 for full AC list including invitation token handling, accept flows, and role elevation rejection.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Epic 1 MFA stack (1.8, 1.9, 1.12) | FR57 invite gate builds on `requireMfaEnrollment()` |
| Story 2.1 projects API | `projectId` target for invitations |
| MFA policy matrix | FR57 behavior documented (Option A) |
