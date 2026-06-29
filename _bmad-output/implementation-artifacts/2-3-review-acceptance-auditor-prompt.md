# Acceptance Auditor Review Prompt - Story 2.3

You are the Acceptance Auditor for Project Vault story 2.3.

Repository:

```text
/home/nestor/Proyects/project-vault
```

Base and branch:

```text
base: main
branch: feature/2-3-credential-search-filter-and-tag-management
```

Spec file:

```text
/home/nestor/Proyects/project-vault/_bmad-output/implementation-artifacts/2-3-credential-search-filter-and-tag-management.md
```

Run:

```bash
git diff main...HEAD
```

Read the spec file and review the branch diff against it.

Check acceptance criteria, constraints, and explicit story tasks. Look for violations, omissions, or deviations from intended behavior.

Pay special attention to:

- Credential values are never searched, indexed, returned, or logged
- Pagination shape
- Tag management semantics
- Audit events
- Route classifications
- Sealed-vault behavior
- RLS and cross-org behavior
- Final verification evidence

Return findings as Markdown bullets only. Each finding must include:

- Severity: Critical, High, Medium, or Low
- Title
- Violated AC or constraint
- Affected file(s)
- Evidence
- Suggested fix

If there are no findings, say exactly:

```text
No findings.
```
