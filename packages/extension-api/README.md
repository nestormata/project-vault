# `@project-vault/extension-api`

The typed contract for Project Vault extensions. It is intended for extension authors whose
module is loaded by a Project Vault host process, including consumers in a separate repository.

```sh
pnpm add @project-vault/extension-api
```

The package is ESM-only (`"type": "module"`) and provides no CommonJS export condition. Use
`import` in consumers; newer Node releases may interoperate with `require()` as an implementation
detail, but that is not a supported CommonJS contract. Use Node.js 20 or newer and TypeScript 5.6.3 or
newer when compiling an extension. The package's declarations are checked in this repository with
the consumer-facing NodeNext and Bundler resolution modes.

## Minimal extension

```ts
import type {
  AuthResult,
  AuthStrategy,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'
import { defineExtension } from '@project-vault/extension-api'

const manifest: ExtensionManifest = defineExtension({
  name: 'com.example.sso',
  apiVersion: '1.1.0',
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

Exported types are `AuthResult`, `AuthStrategy`, `NotificationChannel`, `NotificationPayload`,
`UIPanel`, `UIPanelContext`, `UIPanelResult`, `CapabilityDecision`, `CapabilityGate`,
`CapabilityGateContext`, `AuditEventSourceHost`, `AuditEventSourceWriteInput`,
`AuditEventSourceWriteResult`, `HostServices`, `ExtensionCapability`, `ExtensionManifest`,
`ExtensionHooks`, and `ExtensionRegistrationErrorReason`. Exported runtime values are
`EXTENSION_API_VERSION`, `HOST_SUPPORTED_EXTENSION_API_RANGE`, `defineExtension`,
`registerExtension`, `isExtensionApiVersionSupported`, and `ExtensionRegistrationError`.

Story 23.8 adds the first **inverted** hook: `AuditEventSourceHost` is implemented by the host
(Project Vault), not the extension. `hooksFactory` therefore takes a `host: HostServices` argument
(`hooksFactory: (host: HostServices) => ExtensionHooks`) — an existing extension whose
`hooksFactory` declares zero parameters remains compatible unmodified (TypeScript parameter-count
contravariance). Call `host.auditEventSource.writeAuditEvent(input)` to write a tamper-evident,
namespaced (`ext.<your-manifest-name>.*`) audit row; the host performs HMAC signing and
key-versioning, so no key material or transaction handle ever crosses the extension boundary.

Only the package root is supported. Deep paths such as `@project-vault/extension-api/hooks/*` are
unsupported internals and may move, be renamed, or be deleted in any release, including a patch;
the root export is the only surface covered by the compatibility contract.

## Compatibility and two copies

The host owns the compatibility decision. At load time the Project Vault host calls
`registerExtension(manifest, hooksFactory)` using the host's copy of this package. The extension
declares the exact version it was built against (`apiVersion: '1.1.0'`); do not call
`registerExtension()` from the extension itself. Export `{ manifest, hooksFactory }` as the default
and let the host validate it. A consumer may use `isExtensionApiVersionSupported()` for a
best-effort preflight signal, but it is not the authoritative host check.

`EXTENSION_API_VERSION` equals this package's `package.json` version and the release tag. The
release check proves that triangle is internally consistent. It does not prove that a third-party
module is trustworthy or that the process is an isolation boundary. The current host-authoritative
gate rejects ranges and wildcards; the earlier extension-supplied-range design was corrected in
Project Vault Story 24.3. Provenance and review are still required for the supply chain.

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

The package is licensed `AGPL-3.0-or-later`. That license has not been changed or cleared for a
closed-source SaaS consumer. Whether CentralizeMe may link this runtime package in-process, how
AGPLv3 §13 applies to its hosted service, whether bot contributions are covered by the CLA, and
whether shipping `src/` is sufficient Corresponding Source are unresolved questions escalated for
qualified legal review. Publishing is not a legal clearance.

## Versioning

Until Project Vault Story 23.6 publishes the full versioning and deprecation policy, the interim
stance is strict semver: adding an export or optional field is minor; removing, renaming, or
narrowing an export or changing registration validation semantics is major. Story 23.3's
`CapabilityGate` addition and Story 23.8's `AuditEventSourceHost`/`HostServices` addition are both
pre-classified as minor bumps (additive, backward-compatible). No deprecation-window commitment is
made here; Story 23.6 must review its policy against this publishing mechanism.

Source is included in the package tarball with the compiled output and license. See the public
repository's [architecture decision record](https://github.com/nestormata/project-vault/blob/main/_bmad-output/planning-artifacts/architecture.md)
for the release comparison, risk controls, and recovery runbook.
