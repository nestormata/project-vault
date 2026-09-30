# Project Vault Individual Contributor License Agreement (CLA)

**Version 2**

Thank you for your interest in contributing to Project Vault ("the Project"), maintained by the
Maintainer defined below.

This is an **individual** contributor license agreement. It is signed once, automatically, by
posting the sign-off comment on your first pull request (see `CONTRIBUTING.md` for how the
signing flow works).

> **Not legal advice.** This CLA text is a solid starting draft, informed by common
> Apache-style and Harmony-style contributor agreements, but it has **not yet been reviewed by
> an attorney**. This version 2 in particular is **pending legal review**. It is the
> maintainer's intent to obtain real legal review before the project's external contributor
> base scales significantly. Do not treat this document as a substitute for professional legal
> advice, and do not remove this notice as part of "resolving" it — it is a deliberately open
> item, not an oversight.

## Definitions

- **"Maintainer"** means Nestor Mata Cuthbert and his successors and assigns, including any legal
  entity he controls or designates (for example a company he forms to operate commercial
  products built on Project Vault).
- **"MIT-Licensed Package"** means a package in this repository that the repository explicitly
  licenses under the MIT License: its own directory contains a `LICENSE` file with the MIT
  License text, and its package manifest declares `"license": "MIT"`. As of this version, the
  only MIT-Licensed Package is `packages/extension-api` (published as
  `@project-vault/extension-api`). Any future package whose own `LICENSE` file is the MIT
  License, such as the planned UI composition kit, is also an MIT-Licensed Package.
- **"AGPL Portions"** means everything in the Project that is not an MIT-Licensed Package. The
  AGPL Portions are licensed under the GNU Affero General Public License, version 3 or (at your
  option) any later version ("AGPL-3.0-or-later"), as stated in the repository's root `LICENSE`
  file.

## Scope

This CLA covers any contribution — code, documentation, configuration, or other material — that
you submit to the Project's repositories (source-controlled by the Maintainer), by any means
including pull requests, patches, or other Git-based submission ("Contribution").

This CLA governs **contributions you make back to this repository only**. It does **not**
restrict, license, or otherwise affect what you or anyone else does with the Project's own source
code in your own self-hosted deployment or fork. Running, modifying, or redistributing Project
Vault under the terms of its open-source licenses (AGPL-3.0-or-later for the AGPL Portions, the
MIT License for the MIT-Licensed Packages) is entirely separate from this agreement and is
unaffected by whether you have ever signed it.

## 1. You keep your copyright

You retain all right, title, and interest in and to your Contribution. Signing this CLA does
not transfer copyright ownership of your Contribution to the Maintainer.

## 2. The Project stays open source

Your Contribution, once merged into this repository, remains part of the Project and is licensed
to the public — forever — under the open-source license of the part of the repository it
becomes part of:

- A Contribution to the AGPL Portions is licensed to the public under AGPL-3.0-or-later, the same
  license that already covers the rest of those portions.
- A Contribution to an MIT-Licensed Package is licensed to the public under the MIT License, the
  same license that already covers the rest of that package.

A single pull request that touches both is licensed file by file, according to where each part
of it lands.

The Maintainer will not relicense the AGPL Portions of the Project (i.e., the open-source
repository as distributed to the public) under terms more restrictive than AGPL-3.0-or-later as
a result of this agreement. Licensing a package under the MIT License, which is more permissive
than the AGPL and not more restrictive, is consistent with that commitment. Using the license in
section 3, the Maintainer may also make other parts of the Project available under the MIT
License in the future (for example, code moved into the planned UI composition kit); any such
change will be stated in that package's own `LICENSE` file. Nothing in this agreement withdraws
the open-source license under which any version of the Project has already been published.

## 3. You grant the Maintainer a broader, separate license

Separately from (1) and (2) above, and in addition to the rights the Project's open-source
licenses already grant to the public, you grant the Maintainer a perpetual, worldwide,
non-exclusive, royalty-free, irrevocable, transferable, assignable, and sublicensable license
to:

- use, reproduce, modify, prepare derivative works of, publicly display, publicly perform,
  sublicense, and distribute your Contribution, and
- do so **outside the terms of the AGPL-3.0-or-later and the MIT License**, including as part of
  closed-source, proprietary, or commercial products or services — such as a hosted
  software-as-a-service offering built on top of the open-source core.

The Maintainer may transfer or assign this license, in whole or in part, and may grant
sublicenses under it (with the right for sublicensees to grant further sublicenses), to any of
the Maintainer's successors or assigns, including any legal entity Nestor Mata Cuthbert controls
or designates. Such a transfer or assignment may happen on its own or together with an
assignment of the Maintainer's own copyright in the Project, and needs no further notice to, or
consent from, you. This agreement binds you and benefits the Maintainer and the Maintainer's
successors and assigns.

This is the mechanism that lets the Maintainer — today Nestor Mata Cuthbert, and in future a
company he forms to operate commercial products built on Project Vault — fold community
contributions into a commercial hosted SaaS product while keeping the open-source repository
itself under its open-source licenses for everyone. This dual-use intent is disclosed here, and
in `CONTRIBUTING.md`, transparently and in advance — not after the fact.

## 4. Your representations

By signing, you represent that:

- Each Contribution is your own original creation, or you otherwise have the right to submit it
  under this CLA (e.g., you have secured any necessary rights from a prior employer or other
  rights-holder);
- You are legally entitled to grant the licenses in this agreement, e.g. if your employer has
  rights to intellectual property you create, you have received permission to make the
  Contribution on your employer's behalf, or your employer has waived such rights;
- To the best of your knowledge, your Contribution does not violate any third party's
  copyrights, trademarks, patents, or other intellectual property rights.

## 5. No warranty

Unless required by applicable law, your Contribution is provided "AS IS", without warranties or
conditions of any kind, express or implied.

## Individual vs. corporate contributors (scope note)

This is an **individual contributor** agreement only. It does not yet include a separate
corporate/entity CLA variant for contributions made on behalf of an employer that might
otherwise assert rights over an employee's work. This is a deliberate simplification: an
individual CLA is being adopted first because it covers the Project's current contributor base,
not because corporate contributions were considered and excluded. A corporate CLA addendum is a
documented candidate for future addition if/when a contributor needs to submit on behalf of an
employer.

## How signing works

See `CONTRIBUTING.md` for the mechanics — signing happens automatically the first time you open
a pull request, via an automated status check and a bot comment on the PR itself. You do not
need to do anything before that point.

## Version history

- **Version 2 (2026-09-30).** Defines the Maintainer to include Nestor Mata Cuthbert's
  successors, assigns, and any legal entity he controls or designates; makes the section 3 grant
  expressly transferable, assignable, and sublicensable to them; and recognizes the MIT-Licensed
  Packages (starting with `packages/extension-api`) alongside the AGPL Portions. Signatures are
  recorded separately from version 1.
- **Version 1 (2026-07-24).** Initial version. It collected no signatures before version 2
  replaced it.

---

_Version 2, last updated: 2026-09-30. Selected enforcement tooling and its provenance are
recorded in the workflow file at `.github/workflows/cla.yml`._
