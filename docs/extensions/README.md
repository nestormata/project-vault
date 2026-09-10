# Extensions

Project Vault can load exactly one **extension package** per instance. An extension is an ordinary
npm package that the API process imports at boot and hands a set of typed hooks to. Once loaded,
its hooks participate in real request handling: it can be the instance's identity provider, gate
capabilities against an external entitlement system, render panels into the web shell, deliver
notifications, veto project creation, and write into Project Vault's audit log.

An extension is **in-process, fully trusted code**. It is not a plugin sandbox: there is no
isolation boundary between an extension and the API process, and a loaded extension can do
anything the API process can do. Load only code you have reviewed and whose supply chain you
control.

- **[authoring.md](authoring.md)** — write, build, load, and verify your first extension, and
  install one into a production Docker deployment.
- **[`@project-vault/extension-api`](https://github.com/nestormata/project-vault/tree/main/packages/extension-api)**
  — the published typed contract, and the reference for every exported symbol.
- **[extension-api-versioning-policy.md](../extension-api-versioning-policy.md)** — the binding
  compatibility policy: what counts as breaking, how the load-time version gate works, and what
  deprecation you can rely on.

## Shape of an extension

A package's default export is a single object:

```ts
export default { manifest, hooksFactory }
```

- `manifest` describes the extension: its reverse-DNS `name`, the exact `apiVersion` it was built
  against, and the `capabilities` it declares.
- `hooksFactory` is called once at boot, optionally receiving a `HostServices` object, and returns
  the bag of hook implementations.

The host — not the extension — calls `registerExtension()` and decides whether the manifest is
acceptable. Declaring a capability is what makes the corresponding hook legal in the returned bag.

## Capability catalogue

`manifest.capabilities` is an array of these eight literals.

| Capability | Grants |
|---|---|
| `auth-provider` | An `authStrategy` hook — an external identity provider that Project Vault delegates login to. Pairs with the optional `replacesNativeLogin` manifest flag. |
| `notification-channel` | A `notificationChannel` hook — an additional destination for notifications. |
| `ui-panel` | A `uiPanel` hook — server-rendered HTML composed into Project Vault's shell inside a sandboxed iframe. Also unlocks the `uiPanelSlots`, `moduleActions`, and `moduleDataRoutes` manifest fields, and with them the `moduleAction` and `moduleData` hooks. |
| `capability-gate` | A `capabilityGate` hook — an external entitlement decision consulted on every gated check. |
| `audit-event-source` | Permission to *call* `host.auditEventSource.writeAuditEvent()`. Inverted: Project Vault implements it, the extension calls it, and nothing is returned from `hooksFactory()` for it. |
| `project-lifecycle` | A `projectLifecycle` hook (`ProjectCreatePolicy`) that may veto project creation. |
| `delivery-provider` | A `deliveryProvider` map — per-channel delivery implementations replacing the built-in transport for those channels. |
| `project-archive-notify` | A `projectArchiveNotifier` hook — a non-vetoing notification of an already-committed archive, dispatched by a background worker. Deliberately independent of `project-lifecycle`. |

## Hook catalogue

`hooksFactory()` returns an `ExtensionHooks` object. Every field is optional; return only the ones
whose capability you declared.

| Hook | Signature (abridged) | Notes |
|---|---|---|
| `authStrategy` | `onAuthenticate(credential) => AuthResult` | The only hook that can replace native login, and only alongside `replacesNativeLogin: true` plus a host-side proving latch. |
| `notificationChannel` | receives a `NotificationPayload` | |
| `uiPanel` | `onRenderPanel(context) => UIPanelResult` | Fails closed on throw, timeout, or a malformed result. |
| `capabilityGate` | `onCheckCapability(context) => CapabilityDecision` | Never cached by the host: every gated check calls it. Fails closed. |
| `projectLifecycle` | `onBeforeCreateProject(...)` | May veto. Runs in-request. |
| `projectArchiveNotifier` | notification of a committed archive | Never in-request, never vetoing. |
| `moduleAction` | dispatch target for panel actions | Legal only when the manifest declares `moduleActions`. |
| `moduleData` | `Record<"GET <path>", handler>` | Every declared `moduleDataRoutes` entry must have exactly one matching handler. |
| `deliveryProvider` | `Record<channelName, DeliveryProvider>` | Registering the same channel twice in one process is a loud conflict error, not last-one-wins. |

## Host services

`hooksFactory` may declare one parameter, `host: HostServices`, to call back into Project Vault. A
factory declaring zero parameters stays valid, so new services are always additive.

| Service | Method(s) | Purpose |
|---|---|---|
| `auditEventSource` | `writeAuditEvent(input)` | Write a tamper-evident audit row, namespaced `ext.<your-manifest-name>.*`. The host does the HMAC signing and key versioning; no key material or transaction handle crosses the boundary. |
| `orgAuthorization` | `checkMembership()` | Is this identity a member of the current organization at this role or above. |
| `projectAuthorization` | `checkProjectMembership()` | The project-scoped sibling, reusing Project Vault's own effective-project-role semantics (org owner/admin bypass, explicit membership-row fallback). |
| `ephemeralState` | key/value read/write | Short-lived, org-scoped state. Resolves the current request's organization at call time. |
| `monitoring` | eight methods | Project Vault's monitoring surface. Six resolve the current request's organization at call time; two take an explicit `organizationId` because they run outside any request. |
| `notificationOriginator` | `enqueueNotification()` | Enqueue through Project Vault's own notification queue. Not gated by the unrelated `notification-channel` capability. |

Host services are bound once, at load time. Values they return are request-scoped — never cache
them across requests.

## Operational model

- One extension package per instance, named by the `VAULT_EXTENSIONS_PACKAGE` environment
  variable. Unset means no extension is loaded.
- Loading happens once at boot. There is no hot reload and no partial disable: unsetting the
  variable and restarting removes *every* hook that package provided, not just the one that
  misbehaved. Native login cannot be removed by an extension failure, so an operator cannot be
  locked out this way.
- Load failure is reported, not fatal. `GET /health` carries `extensions_status`
  (`not_configured` | `loaded` | `load_failed`).
- The host owns the version decision. An extension declares one exact `apiVersion`; the host
  accepts `>=MAJOR.0.0 <=<host's own version>` and rejects everything else. Ranges and wildcards
  in a manifest are rejected outright.

### Two names for the same failure

A version mismatch is reported under two different names depending on which layer you are reading:

| Layer | Value | Where you see it |
|---|---|---|
| SDK (`@project-vault/extension-api`) | `ExtensionRegistrationError.reason === 'incompatible-version'` | The thrown error, if you call `registerExtension()` yourself. |
| Host loader | `ExtensionLoadFailureReason === 'capability_mismatch'` | The API's boot log, `/health`, and the extension-status route. |

They are the same event. The host maps the SDK's four reasons onto its three:
`incompatible-version` → `capability_mismatch`; `invalid-manifest-field`, `invalid-name`, and
`invalid-db-scope` → `manifest_invalid`; an import crash or a `hooksFactory()` timeout →
`import_error`.

## Reference implementations

Five buildable, runnable fixture extensions live in
[`fixtures/`](https://github.com/nestormata/project-vault/tree/main/fixtures) — one per major
hook. They are test fixtures, not templates to ship, but each one is a complete, working package
with the real manifest shape, and every one of them declares `apiVersion: EXTENSION_API_VERSION`.

| Fixture | Demonstrates |
|---|---|
| `mock-sso-extension` | `authStrategy` |
| `mock-envelope-extension` | `authStrategy` with `replacesNativeLogin` |
| `mock-capability-gate-extension` | `capabilityGate` |
| `mock-audit-event-source-extension` | Calling `host.auditEventSource` |
| `mock-ui-panel-extension` | `uiPanel` and declared slots |
