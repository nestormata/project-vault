# Project Vault Extension API Versioning and Deprecation Policy

## Status

**in force.** Story 24.3's host-authoritative load-time compatibility gate landed before this
policy was published, so the policy is binding for the public `@project-vault/extension-api`
contract. The current package contract version is `1.4.0`. This document is v1 and is
channel-independent; its remaining distribution handoff is tracked against Story 23.1.

## Scope — what v1 does not answer

This policy answers contract classification, runtime compatibility, deprecation, notification,
version allocation, public surface, and supply-chain expectations. It does not answer the exact
distribution channel, publish immutability implementation, unpublish availability, consumer pin
syntax, or the exact event that starts the notice-window clock. Those channel-specific questions
belong to Story 23.1's publishing mechanism and its follow-up acceptance criteria. The separate
`## Distribution & immutability` section is intentionally a visible handoff, not an implied
promise.

## Change classification

### The Obligation Rule

**A change is BREAKING if and only if it increases what an out-of-repo party must provide, or
decreases what an out-of-repo party may rely on.** The most severe classification wins when a
change is both additive and breaking.

### TypeScript classification table

| #   | Change                                                                                                     | Verdict and reason                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Adding an optional field to any exported object type                                                       | **NON-BREAKING** — consumers may omit it.                                                                                                     |
| 2   | Adding a required field to a type PV passes to the extension                                               | **NON-BREAKING** — imported or wider parameter types still accept the value.                                                                  |
| 3   | Adding a required field to a type PV receives from the extension                                           | **BREAKING** — every existing implementation must now provide it.                                                                             |
| 4   | Widening a parameter type on a method the extension implements                                             | **NON-BREAKING** — existing arguments remain accepted.                                                                                        |
| 5   | Narrowing a parameter type on a method the extension implements                                            | **BREAKING** — an existing implementation may receive a value it can no longer accept.                                                        |
| 6   | Adding a member to a union PV receives, such as `ExtensionCapability`                                      | **NON-BREAKING** — suppliers may keep sending the old set; PV's in-repo exhaustive switches fail at build time, not at the external boundary. |
| 7   | Adding a member to a union PV produces and consumers switch on, such as `ExtensionRegistrationErrorReason` | **BREAKING** — consumers may not handle the new value.                                                                                        |
| 8   | Removing a member from any union                                                                           | **BREAKING** — an existing relied-on value disappears.                                                                                        |
| 9   | Widening the declared return type of a method the extension implements                                     | **NON-BREAKING** — implementers may keep returning the narrower type; reclassify if an external consumer must handle the new value.           |
| 10  | Narrowing the declared return type of a method the extension implements                                    | **BREAKING** — existing implementations may return values now disallowed.                                                                     |
| 11  | Adding a new hook type and a new optional field on `ExtensionHooks`                                        | **NON-BREAKING** — an extension can continue to omit it.                                                                                      |
| 12  | Adding a required field to `ExtensionHooks`                                                                | **BREAKING** — every implementation must provide it.                                                                                          |
| 13  | Removing any export from `src/index.ts`                                                                    | **BREAKING** — a documented import no longer resolves.                                                                                        |
| 14  | Renaming any export                                                                                        | **NON-BREAKING** only while the old name remains as a deprecated alias for the full notice window; removal of the alias is **BREAKING**.      |
| 15  | Changing a method from sync to async or vice-versa                                                         | **BREAKING** — timing and the returned value contract change.                                                                                 |
| 16  | Making an existing required field optional on a type PV receives                                           | **NON-BREAKING** — implementers provide less, and only in-repo PV code must handle absence; reclassify if an external party reads it.         |
| 17  | Adding an `ExtensionCapability` literal and requiring extensions to declare it                             | **BREAKING** — existing manifests must provide a new obligation.                                                                              |
| 18  | Changing runtime behaviour with no type change                                                             | See [Runtime behaviour in the contract](#runtime-behaviour-in-the-contract); the named behaviours below are **BREAKING**.                     |

Rows 6, 9, 10, and 16 turn on one fact: **out-of-repo breakage is a contract break; in-repo
breakage is a build failure.** `optional` is the strongly preferred default for every new
manifest/receive-side field. A required receive-side field needs a conscious justification in the
story that introduces it.

Story 23.3 adds a `CapabilityGate` hook: a new exported type, `capabilityGate?: CapabilityGate`
(optional) on `ExtensionHooks`, and `'capability-gate'` in the `ExtensionCapability` union. By
rows 11, 1 and 6 this is **entirely non-breaking** → **minor**.

If Story 23.2 adds `replacesNativeLogin` to `ExtensionManifest` as **optional**, that is row 1 →
**minor**. As **required**, it is row 3 (`ExtensionManifest` is receive-side) → **major**, and by
the notice window it could not ship inside Epic 23's timeline. This table is enforced by a
reviewer applying it to the surface-snapshot diff (AC-12); nothing infers the correct bump.

## Direction of flow

> **Direction determines severity.** Adding a required field to an object PV passes to an
> extension is **NON-BREAKING**: an extension implementation typed with the imported type or a
> wider type still typechecks. Adding a required field to an object PV receives from an extension
> is **BREAKING**: existing implementations no longer satisfy the type.

`UIPanelContext` and `NotificationPayload` flow **PV → extension**. Adding required `orgId:
string` to either is non-breaking. `AuthResult`, `UIPanelResult`, and `ExtensionManifest` flow
**extension → PV** and are receive-side; adding required `tenantId: string` to either is breaking.
`ExtensionManifest` is named explicitly because Story 23.2 modifies it. A type used in both
directions is treated as receive-side, the stricter classification; no such type exists today.
Authors should import PV types rather than redeclare structurally compatible literals—PV makes no
guarantee for a redeclaration that omits the imported contract.

## Runtime behaviour in the contract

Observable runtime behaviour of exported functions, and loader behaviour an extension can observe,
is part of the contract even when `.d.ts` output is byte-identical. The following are breaking
without a type change: tightening `REVERSE_DNS_NAME_PATTERN`; changing
`isExtensionApiVersionSupported()` comparison semantics or `includePrerelease`; making
`hooksFactory` eager rather than lazy; changing the `ExtensionRegistrationErrorReason` for a
failure; reducing the loader's `DEFAULT_TIMEOUT_MS` (`apps/api/src/extensions/loader.ts:76`); or
changing the mapping from registration-error reason to load-failure status.

The current named behaviour is pinned in
`packages/extension-api/contract-behaviour.snapshot.md`: the reverse-DNS pattern source,
`includePrerelease: false`, the 5000ms loader timeout, and the
`incompatible-version → capability_mismatch` mapping. The guard reads the real definitions,
including `apps/api/src/extensions/loader.ts`, and fails on drift. Loosening the name pattern to
accept uppercase is **NON-BREAKING** (more inputs accepted) → minor; tightening it is **BREAKING**
→ major plus the notice window. A bug fix that makes behaviour match this documented contract is a
patch, but needs a CHANGELOG entry marked `[behaviour]` because a consumer may depend on a bug.

The golden file pins named constants, not arbitrary control flow. A behavioural break changing
neither a pinned constant nor the type surface remains review-enforced only; the residual is
honest and finite rather than silently treated as covered.

## Semver discipline

Strict SemVer 2.0.0 applies from `1.0.0` onward. Breaking changes under the classification table
or runtime contract require a **major**; additive changes require a **minor**; fixes and
documentation-only changes require a **patch**. `EXTENSION_API_VERSION` and
`packages/extension-api/package.json`'s `version` remain byte-identical, as enforced by
`packages/extension-api/src/manifest.test.ts:15-20`. Stable ranges do not accept prerelease hosts;
the existing `includePrerelease: false` semantics remain deliberate. No `0.x` “anything goes”
semantics apply again.

The **pre-publication grandfather clause** was a dated, expiring exception: changes to the
load-time mechanism before the package's first publication (before Story 23.1) could ship as a
minor despite being breaking under the runtime rule, because no external party existed. It expired
automatically at first publication and may never be re-invoked. Its one use is recorded in the
`1.1.0` CHANGELOG entry with `[pre-publication-exception]` and its date. The current package is
public-ready, so this clause is closed. Two independent non-breaking changes in one release cycle
share one minor; a change that is additive and breaking takes the major classification.

## Public surface and the experimental tier

The public API is exactly what `src/index.ts` exports (`:11-22`), reached through the package root.
The package `exports` map declares no subpaths, and the index comment forbids adding them. A deep
import such as `@project-vault/extension-api/dist/hooks/auth-strategy.js` is not public API and
carries no guarantee; `@project-vault/extension-api` imports of `AuthStrategy` are covered.

The explicitly unstable tier is marked by both an `@experimental` JSDoc tag on the export in
`index.ts` and an `Unstable_` name prefix. Experimental exports may change or be removed in a
minor. Promotion is a minor, drops the prefix, and retains the prefixed name as a deprecated alias
for the full notice window. The marker lint enforces the two-way bijection. `CapabilityGate` is the
first candidate because it is being designed against one consumer's guessed-at needs; the escape
hatch prevents premature freezing without granting an unmarked breaking path.

`EXTENSION_API_VERSION` is a value export and consumers may branch on its value; changing that
value is the versioning mechanism and is not itself breaking. Removing it or changing its type is
breaking. Transitively reachable types are public too. There are **zero transitively-unexported
types today**: every current dependency is explicitly re-exported, including `AuthResult`.

## Deprecation lifecycle

A symbol is deprecated by a `@deprecated` JSDoc tag **on the export in `index.ts`** with three
machine-readable fields:

```ts
/**
 * @deprecated replacement: NewPanel; earliest-removal: 2.0.0; notice-window-ends: 2026-12-01
 */
export type OldPanel = NewPanel
```

The deprecation ships in a **minor** and a CHANGELOG entry announces it. The marker lint requires
`replacement:`, `earliest-removal:` (a version whose major is higher than the current major), and
`notice-window-ends:` (an ISO date at least 90 days after the deprecation entry's publication).
The symbol is removed only in a subsequent major and only after that date. It must work identically
for the entire window; deprecation is not permission to degrade it. A rename retains both names,
with the old name deprecated, until the alias is removed.

Security fixes may bypass the notice window, but must ship as a major and be coordinated directly
with every known consumer through the channels below, not announced only in a CHANGELOG.

## Notice window

The minimum notice window is **90 days** between publishing a deprecation and publishing the major
that removes it. This number is **provisional and not derived from measured data**: PV has no record
of CentralizeMe's redeploy cadence. Its basis is that 90 days spans at least one normal release
cycle on both sides plus slack for a holiday or one person being unavailable; the blast radius is
every instance at once, so this window does the work a staged rollout would do elsewhere.

The CM maintainer of record must confirm or replace the number before Story 23.1 publishes. If it is
unconfirmed at first publication, the fail-safe default is **180 days**, never a shorter window.
The trigger is the publication event, not a calendar date, so it cannot silently lapse.

PV has **no mechanism today to notify an external consumer of anything**—no mailing list, release
feed, or consumer registry. Until a stronger mechanism exists, every deprecation uses all three
channels: (i) a CHANGELOG entry, (ii) a GitHub Release on `nestormata/project-vault` tagged
`extension-api-v<version>`, and (iii) an issue opened on the consumer's own repository. Every
`### Deprecated` CHANGELOG entry contains `Notified:` with the date, channel, and recipient.

For example, a deprecation published `2026-09-01` in `1.5.0` for
`AuthResult.providerName` records `notice-window-ends: 2026-11-30` and
`Notified: 2026-09-01, GitHub issue centralizeme-sass#NNN`; a `2.0.0` removal cannot publish on
`2026-10-01`. A non-security break before the window does not ship: redesign it as additive, mark
the old shape deprecated, and remove it later. The clock starts when the deprecation is published,
not when its branch is merged.

## Known consumers

The known consumer is **CentralizeMe (`centralizeme-sass`)**. Onboarding another consumer requires
adding it and its contact/issue location here before the first contract dependency is merged.

## Version allocation

Version numbers are allocated **at merge, not at planning**. Story 23.2 (`replacesNativeLogin`)
and Story 23.3 (`CapabilityGate`) both planned `1.0.0 → 1.1.0`; both are legitimately “the
minor”. Whichever merges first takes `1.1.0`; the second must rebase and take `1.2.0`. A story's
literal number is a proposed bump size, not a reservation.

The old merge-base-only guard did **not** catch this collision: both branches forked at `1.0.0`,
both produced `1.1.0`, and both compared unequal versions against the fork commit. Comparing with
the tip of `main` catches the duplicate; comparing with the merge-base catches a missing bump.
Neither comparison alone is sufficient. The target rule is:

> `semver.gt(headVersion, versionAt(mergeBase)) && semver.gt(headVersion, versionAt(tipOfBase))`.

The current Story 24.4 guard is landed and enforces canonical, forward-only versions. Pull requests
compare with the target branch tip and pushes use the first parent; local merge-base runs retain a
documented residual for concurrent allocations. Before 24.4 landed, this collision was enforced by
rebase discipline only—the human coordination the rule exists to remove. The collision happened
before this policy existed, precisely the argument for this policy.

The positive case is explicit: if 23.3 merges Monday as `1.1.0` while 23.2's branch still says
`1.1.0`, `gt(1.1.0, tip 1.1.0)` is false and CI fails; after rebasing, 23.2 takes `1.2.0`.
Two branches in a merge queue on the same day follow the same rule.

## Load-time compatibility gate

Story 24.3 is complete and the policy is now in force. The rejection path is fail-safe: registration
throws `ExtensionRegistrationError('incompatible-version', ...)` before `hooksFactory` runs; the
loader records `load_failed` with `capability_mismatch`, emits its operational failure event, and
the API continues without wiring the extension. Malformed versions are rejected without throwing
through the loader, and stable-host prerelease handling remains deliberate.

The original predicate was structurally wrong: the extension supplied a range and PV checked
`satisfies(hostVersion, extensionDeclaredRange)`, allowing `*`, `x`, `>=1.0.0`, and similar
permanent opt-outs. The required host-authoritative design is now shipped:
`satisfies(extensionDeclaredApiVersion, HOST_SUPPORTED_EXTENSION_API_RANGE)`. Reversing the trust
direction was free before publication and became expensive after it; this is why Story 24.3 had to
land before the package became a public contract.

The pre-24.3 probe recorded `1.0.0` against `^1.0.0` as true, `1.0.0` against `^1.2.0` and
`2.0.0` against `^1.0.0` as false, malformed `banana` as false without throwing, and `*`, `x`,
`>=1.0.0`, and `>0.0.1` as the dangerous true bypasses. The shipped gate reverses that trust
direction and requires a canonical concrete extension version. Rejection remains before
`hooksFactory`, uses the existing reason, and the message distinguishes an outside-supported-range
failure from any future boundedness rejection.

If a future implementation cannot retain the host-authoritative design, the boundedness fallback
is exact and not optional prose. A range `R` is admissible only when `semver.validRange(R)` is
non-null and:

```ts
semver.subset(R, '<' + (semver.major(EXTENSION_API_VERSION) + 1) + '.0.0-0', {
  includePrerelease: true,
})
```

Throws are caught as inadmissible. The `-0` cap excludes the next major and all its prereleases;
the cap is derived, never hard-coded. This fallback rejects `*`, `>=1.0.0`, `^1.0.0 || ^2.0.0`,
`1.0.0 || 2.0.0-alpha`, and malformed ranges. It still constrains an untrusted declaration,
so it is a mitigation; host authority is the fix. No new error-reason union member is introduced.
If boundedness rejection is ever added, its message must be distinguishable from a range mismatch,
and the silent-at-upgrade-time rollout must be accounted for.

## CI version-skew guard

Story 24.4 owns the guard, not this story's runtime code. Its conformance checklist is:

1. Fail unless head and both base versions are canonical semver and the strict two-sided increase
   holds; name the failed condition.
2. Reject downgrades, garbage, and a deleted `version` field.
3. Establish a new-package case positively: absence at base and presence at head must be proven,
   not inferred from `undefined`, which also means an unreadable base.
4. Track the contract, not a directory: exclude `*.test.ts` and the surface snapshot; include the
   behaviour snapshot and `apps/api/src/extensions/loader.ts`.
5. Keep local fail-open only for local developer ergonomics; CI/GitHub Actions must fail closed and
   push-to-main must compare the first parent.

The shipped guard verifies strict canonical forward movement and the reviewed PR/push ranges. It
does not infer whether a type change is major, minor, or patch; the surface snapshot and reviewer
classification do that. It also retains the documented local merge-base residual. The policy does
not claim this story repaired or duplicated Story 24.4.

Historically the guard watched every `packages/extension-api/src/**` edit, including test-only
files, accepted any inequality (downgrade or garbage), treated an unreadable base as a new package,
failed open on diff errors, and was a no-op for direct pushes to `main`. Those are the limitations
that the 24.4 conformance checklist was created to close; this story does not reimplement that
guard.

## Supply chain

These are policy requirements; the publishing implementation belongs to Story 23.1. A published
version is permanent and never mutated in place. A bad version is corrected with a new higher
version, a CHANGELOG entry marking the bad one, and, where supported, a deprecation marker on the
bad version. `npm unpublish` is not remediation: its 72-hour availability and reproducibility harm
make it unsuitable for an in-process consumer.

Published artifacts must be immutable **and attested**: provenance is recorded, publishing occurs
only from CI, credentials are scoped and 2FA-protected. A package must declare an explicit `files`
allowlist covering `dist/`, `README.md`, `CHANGELOG.md`, and this policy document while excluding
`src/`, tests, and coverage. A patch is not a free pass: it reaches every instance and carries the
same provenance requirements as a major. The snapshot and changelog guards make contract drift
visible; they do not replace release attestation.

## Distribution & immutability

v1 does not answer this. Story 23.1 fills it—see that story's acceptance criteria for the exact
channel, immutable publication, package `files` allowlist, and publication-clock decision.

## Cross-references and ownership

This policy originated from `centralizeme-sass/docs/adr/0005-pv-host-cm-module-pack-architecture.md`,
Consequences, the bullet stating that `packages/extension-api` becomes a public cross-product
contract. It constrains Story 23.1's publishing mechanism, Stories 23.2 and 23.3's additive surface
changes, Story 23.4 if envelope claims become package types, and Story 14.9's historical Publish
Readiness decision. Epic 24 Story 24.3 owns the load-time gate and is complete; Story 24.4 owns the
CI skew guard and is complete. The AC-16 handoff is recorded on Story 23.1 in the private planning
overlay. This document does not edit or require changes in `centralizeme-sass`.

## Evidence and maintenance

The public repository is intended to make this document readable at:
https://github.com/nestormata/project-vault/blob/main/docs/extension-api-versioning-policy.md

The mechanical checks are deliberately separate: the policy structure/link guard, behaviour
golden guard, `Unstable_`/`@experimental` bijection and deprecation-field lint, compiler-derived
`api-surface.snapshot.md` with `since:` index and complete nested member details, and a
content-based CHANGELOG `contract-hash:`. The surface snapshot reports `public contract changed`
when it drifts. The snapshot's `since:` index is authoritative lookup for the two-gates rule: an extension's manifest
lower bound must be at least the `since:` version of every symbol it uses. PV can enforce the
index's correctness, not an out-of-repo author's compliance. A removed and re-added symbol gets a
new `since:` version because the guarantee is continuous availability.

The policy-heading list is a minimum. A heading is added to that list when a section becomes
load-bearing for another AC or story and removed only by the story that deletes the section.
