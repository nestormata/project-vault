# `@project-vault/extension-api`

The typed contract for Project Vault extensions. It is intended for extension authors whose
module is loaded by a Project Vault host process, including consumers in a separate repository.

```sh
pnpm add @project-vault/extension-api
```

New to extensions? Start with the
[extension authoring guide](https://github.com/nestormata/project-vault/blob/main/docs/extensions/authoring.md),
which walks through scaffolding, building, loading, and verifying a first extension end to end.
This README is the contract reference.

## Runtime and toolchain requirements

The package is ESM-only (`"type": "module"`) and provides no CommonJS export condition. Use
`import` in consumers; newer Node releases may interoperate with `require()` as an implementation
detail, but that is not a supported CommonJS contract.

- **Node.js**: 20 or newer (`engines.node` is `>=20`).
- **TypeScript**: this repository builds and typechecks the package's declarations with
  TypeScript **6.0.3**, which is the only tested version. TypeScript 5.6 or newer is expected to
  work — the declarations use no syntax newer than that — but is outside the tested matrix.
- The declarations are checked here under both of the resolution modes a consumer is likely to
  use: NodeNext and Bundler.

Only the package root is supported. Deep paths such as `@project-vault/extension-api/hooks/*` are
unsupported internals and may move, be renamed, or be deleted in any release, including a patch;
the root export is the only surface covered by the compatibility contract.

## Minimal extension

```ts
import type {
  AuthResult,
  AuthStrategy,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'
import { EXTENSION_API_VERSION, defineExtension } from '@project-vault/extension-api'

const manifest: ExtensionManifest = defineExtension({
  name: 'com.example.sso',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['auth-provider'],
})

const authStrategy: AuthStrategy = {
  async onAuthenticate(credential: string): Promise<AuthResult> {
    return { externalSubject: credential, providerName: manifest.name }
  },
}

const hooksFactory = (): ExtensionHooks => ({ authStrategy })
export default { manifest, hooksFactory }
```

### Why `apiVersion: EXTENSION_API_VERSION` and not a literal

`apiVersion` must be an exact version — ranges and wildcards are rejected — and the host accepts
only `>=MAJOR.0.0 <=<the host's own version>` (`HOST_SUPPORTED_EXTENSION_API_RANGE`). Writing the
constant instead of a literal pins the manifest to the exact copy of this package you compiled
against, so:

- **Upgrading the package is enough.** Bump the dependency, rebuild, and the declared version
  moves with it. A hardcoded literal silently rots: it keeps declaring an old version until
  someone remembers to edit the string, and once that literal drops below the host's major floor
  the extension stops loading with `incompatible-version`.
- **You never declare a version you did not compile against.** A literal typed one minor ahead of
  your installed copy claims an API you do not actually have, and the host rejects it — the
  ceiling exists precisely to stop a host loading an extension built against APIs it has not
  shipped.
- **The trade-off:** the declared version becomes whatever you last installed. If you install a
  newer package than the host runs, the ceiling rejects your build — pin the dependency to a
  version the target host supports, or (for a deliberate, temporary rollout overlap only) an
  operator can set `VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST=true` on the host.

Every reference fixture in the Project Vault repository (`fixtures/mock-*`) does exactly this.

## Capabilities

`manifest.capabilities` is a non-empty array of `ExtensionCapability` literals. Declaring a
capability is what makes the matching hook legal in the object returned by `hooksFactory()`.

| Capability | Declares that `hooksFactory()` may return |
|---|---|
| `auth-provider` | `authStrategy` — an external identity provider PV delegates login to. |
| `notification-channel` | `notificationChannel` — an additional notification destination. |
| `ui-panel` | `uiPanel` — server-rendered HTML panels composed into PV's shell. Also enables the optional `uiPanelSlots`, `moduleActions`, and `moduleDataRoutes` manifest fields. |
| `capability-gate` | `capabilityGate` — an external entitlement decision for gated capabilities. |
| `audit-event-source` | Permission to call `host.auditEventSource.writeAuditEvent()`. This is an inverted hook: PV implements it, the extension calls it, so nothing is returned from `hooksFactory()` for it. |
| `project-lifecycle` | `projectLifecycle` — a `ProjectCreatePolicy` that may veto project creation. |
| `delivery-provider` | `deliveryProvider` — per-channel delivery implementations replacing PV's built-in transport for those channels. |
| `project-archive-notify` | `projectArchiveNotifier` — a non-vetoing notification of an already-committed project archive. Deliberately independent of `project-lifecycle`, so an extension that only wants archive notifications is not forced to implement `onBeforeCreateProject`. |

## Hooks returned by `hooksFactory()`

`ExtensionHooks` is a single bag of optional fields. Every one of them is optional; return only
the hooks whose capability you declared.

| Hook field | Type | Purpose |
|---|---|---|
| `authStrategy` | `AuthStrategy` | `onAuthenticate(credential)` → `AuthResult`. |
| `notificationChannel` | `NotificationChannel` | Receives a `NotificationPayload` for a channel this extension owns. |
| `uiPanel` | `UIPanel` | `onRenderPanel(context)` → `UIPanelResult` (HTML rendered into a sandboxed iframe). |
| `capabilityGate` | `CapabilityGate` | `onCheckCapability(context)` → `CapabilityDecision`. Fails closed on throw, timeout, or a malformed decision. |
| `projectLifecycle` | `ProjectCreatePolicy` | `onBeforeCreateProject` — may veto creation. |
| `projectArchiveNotifier` | `ProjectArchiveNotifier` | Dispatched by a background worker after a project archive commits; never in-request, never vetoing. |
| `moduleAction` | `ModuleAction` | Dispatch target for panel actions. Legal only when the manifest declares `moduleActions`. |
| `moduleData` | `Record<string, ModuleDataRouteHandler>` | Keyed by the exact `"GET <path>"` string of each `moduleDataRoutes` entry; every declared route must have exactly one handler. |
| `deliveryProvider` | `Record<string, DeliveryProvider>` | Keyed by notification channel name. Registering the same channel key twice in one process is a loud conflict error, not last-one-wins. |

## Host services injected into `hooksFactory(host)`

`hooksFactory` may declare a single parameter, `host: HostServices`. A factory that declares zero
parameters stays compatible unmodified (TypeScript parameter-count contravariance), so adding a
service is always an additive change.

| Field | Type | What it does |
|---|---|---|
| `auditEventSource` | `AuditEventSourceHost` | `writeAuditEvent(input)` writes a tamper-evident, namespaced (`ext.<your-manifest-name>.*`) audit row. The host performs HMAC signing and key-versioning, so no key material or transaction handle ever crosses the extension boundary. |
| `orgAuthorization` | `OrgAuthorizationHost` | `checkMembership()` — is this identity a member of the current organization at this role or above. |
| `projectAuthorization` | `ProjectAuthorizationHost` | `checkProjectMembership()` — the project-scoped sibling of the above, reusing PV's own effective-project-role semantics (org owner/admin bypass, explicit membership row fallback). |
| `ephemeralState` | `EphemeralStateHost` | Short-lived, org-scoped key/value state. Resolves the current request's org at call time. |
| `monitoring` | `PvMonitoringHost` | PV's monitoring surface. Six of its eight methods resolve the current request's org at call time; two take an explicit `organizationId` because they run outside any request lifecycle. |
| `notificationOriginator` | `NotificationOriginatorHost` | `enqueueNotification()` — enqueue a notification through PV's own queue. Not gated by the unrelated `notification-channel` capability. |

Host services are bound once at extension-load time. Do not cache the request-scoped values they
return across requests.

## The complete public surface

The package exports far more than the examples above use. Rather than duplicating a list that
would immediately go stale, the exhaustive, generated inventory ships in the tarball:

- **[`api-surface.snapshot.md`](./api-surface.snapshot.md)** — every exported symbol, its kind,
  its full type, its members, and the version it was introduced in (`since:`).
- **[`contract-behaviour.snapshot.md`](./contract-behaviour.snapshot.md)** — the non-type parts of
  the contract: the reverse-DNS name pattern, the loader timeout, whether prereleases satisfy the
  range, and how each SDK registration-error reason maps to the host's load-failure reason.

Both files are regenerated and gated in CI, so they cannot drift from `src/index.ts`.

### Panel theming contract (`ui-panel` capability)

PV's host injects a `:root { ... }` `<style>` block declaring `EXTENSION_THEME_CSS_VARS`
(`--pv-ext-surface`, `--pv-ext-ink`, `--pv-ext-muted`, `--pv-ext-brand`, `--pv-ext-line`) into
every composed panel document, resolved from the requesting user's actually-applied PV theme
(base/default chrome colors when no theme is applied). A panel consumes these purely via CSS
`var()` with its own hardcoded fallback:

```css
.cm-access-ink {
  color: var(--pv-ext-ink, #24323b);
}
```

This is a one-way, read-only contract — consuming it is optional, and PV never reads anything back
from the extension's own CSS. See `UIPanel`'s doc comment (`src/hooks/ui-panel.ts`) for the full
panel-authoring accessibility guidance.

## Compatibility and two copies

The host owns the compatibility decision. At load time the Project Vault host calls
`registerExtension(manifest, hooksFactory)` using the host's copy of this package. The extension
declares the exact version it was built against (`apiVersion: EXTENSION_API_VERSION`); do not call
`registerExtension()` from the extension itself. Export `{ manifest, hooksFactory }` as the default
and let the host validate it. A consumer may use `isExtensionApiVersionSupported()` for a
best-effort preflight signal, but it is not the authoritative host check.

`EXTENSION_API_VERSION` equals this package's `package.json` version and the release tag. The
release check proves that triangle is internally consistent. It does not prove that a third-party
module is trustworthy or that the process is an isolation boundary. The host-authoritative gate
rejects ranges and wildcards. Provenance and review are still required for the supply chain.

An in-process consumer can have its own copy while the host has another. The types are structural,
but the consumer's `EXTENSION_API_VERSION` is not the host's version, and `instanceof
ExtensionRegistrationError` can fail across copies. Discriminate errors by their `reason` field.
Declare this package as a `peerDependency` in an extension where possible; pnpm's non-hoisted
layout can still leave two copies, so the rules above remain mandatory.

Prerelease versions do not satisfy a stable compatibility range. The host constant therefore stays
on a stable version; prerelease registry artifacts are staged under a non-`latest` dist-tag.

## Release and provenance

The release workflow uses npm Trusted Publishing (OIDC), npm provenance, a required `npm-publish`
environment approval, and the `extension-api-vMAJOR.MINOR.PATCH` tag format. Releases publish to
`next` first. A maintainer promotes a verified version to `latest` only after an external consumer
install and `npm audit signatures` pass. Consumers must verify provenance (or an equivalent
attestation), pin the lockfile integrity, apply a minimum-release-age/cooldown, and use
`--frozen-lockfile` in production.

## Versioning and deprecation

The package follows strict SemVer for its public extension contract. The canonical, binding policy
— change classification, the load-time compatibility gate, deprecation windows, version
allocation, and supply-chain expectations — is published at
[`docs/extension-api-versioning-policy.md`](https://github.com/nestormata/project-vault/blob/main/docs/extension-api-versioning-policy.md).

## Licensing status

The package is licensed `AGPL-3.0-or-later`. Source is included in the package tarball alongside
the compiled output and the license. Publishing to a registry is a distribution decision, not a
legal clearance: if you intend to link this package in-process from a closed-source or hosted
service, evaluate AGPLv3 (including §13) against your own deployment with your own counsel.
