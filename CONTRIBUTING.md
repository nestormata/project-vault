# Contributing to Project Vault

Thanks for your interest in contributing. This document covers the practical workflow and the
legal requirements that apply to every external contribution.

## Before you start writing code: the CLA

**When it happens:** you do **not** need to sign anything before you start writing code or
before you open your first pull request. The Contributor License Agreement (CLA) is signed
automatically, from inside the PR itself, the first time an automated bot detects an unsigned
PR from you — it posts a comment with a one-line instruction, and a required status check blocks
the PR from merging until you follow it. There is no separate portal, account, or upfront step.

**Who needs to sign:** every external contributor, for every pull request, with **no
size exception**. Even a one-line typo fix requires a signed CLA before it can be merged. This
is a deliberate v1 simplicity decision, not an oversight: copyright attaches to a contribution
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

The full legal text, including both of these clauses in detail, is in [`CLA.md`](./CLA.md).
Please read it before your first PR.

**This CLA governs contributions back to this repository only.** It does not restrict what you
or anyone else does with Project Vault's own AGPLv3 source code in a self-hosted deployment or a
fork — that remains governed solely by the AGPLv3 license terms in [`LICENSE`](./LICENSE),
unaffected by whether you've ever signed the CLA.

> **Not legal advice.** The CLA text is a solid starting draft but has not yet been reviewed by
> an attorney; see the caveat at the top of `CLA.md`. It also currently covers individual
> contributors only — a corporate/entity variant is a documented future addition, not
> implemented in v1.

## How to contribute

1. Open an issue or discussion first for anything nontrivial, so scope and approach can be
   agreed before you invest time.
2. Fork the repository and branch from `main`.
3. Follow this repo's existing development setup, coding standards, and CI quality gates — see
   the [Getting Started](./README.md#getting-started) and [CI Quality Gates](./README.md#ci-quality-gates)
   sections of `README.md`, and `AGENTS.md` for AI-assisted development conventions. This
   document intentionally does not duplicate that material.
4. Open a pull request against `main`. The PR template will remind you of the CLA requirement.
5. On your first PR, the CLA bot will comment with signing instructions if you haven't signed
   yet; the PR cannot merge until the required "CLA signed" status check passes.
6. Address review feedback; once approved and the CLA check passes, a maintainer will merge.

## Reporting security issues

Do not open a public issue for security vulnerabilities. See the Security section of
`README.md` / the forthcoming `SECURITY.md` for the reporting channel.
