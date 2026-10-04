# Extensions

Project Vault can load exactly one **extension package** per instance. An extension is an ordinary
npm package that the API process imports at boot and hands a set of typed hooks to. Once loaded,
its hooks participate in real request handling: it can be the instance's identity provider, gate
capabilities against an external entitlement system, render panels into the web shell (the
legacy runtime UI extension API, deprecated and frozen; see
[UI extension tiers](#ui-extension-tiers)), deliver
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
| `ui-panel` | A `uiPanel` hook — server-rendered HTML that the host sanitizes and renders inline in Project Vault's shell. Also unlocks the `uiPanelSlots` and `moduleActions` manifest fields, and with them the `moduleAction` hook. This is the legacy runtime UI extension API (HTML panels), which is deprecated and frozen. The `moduleDataRoutes` manifest field and its `moduleData` hook are **not** part of this capability: they need no capability declaration (they are the current API-route mechanism; see [UI extension tiers](#ui-extension-tiers)). |
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
| `uiPanel` | `onRenderPanel(context) => UIPanelResult` | Fails closed on throw, timeout, or a malformed result. Part of the legacy runtime UI extension API (HTML panels; deprecated and frozen). |
| `capabilityGate` | `onCheckCapability(context) => CapabilityDecision` | Never cached by the host: every gated check calls it. Fails closed. |
| `projectLifecycle` | `onBeforeCreateProject(...)` | May veto. Runs in-request. |
| `projectArchiveNotifier` | notification of a committed archive | Never in-request, never vetoing. |
| `moduleAction` | dispatch target for panel actions | Legal only when the manifest declares `moduleActions`. See [Module actions and ActionResult](authoring.md#module-actions-and-actionresult). Part of the legacy runtime UI extension API (HTML panels; deprecated and frozen). |
| `moduleData` | `Record<"GET <path>", handler>` | Every declared `moduleDataRoutes` entry must have exactly one matching handler. Deprecated and frozen with `moduleDataRoutes` (a separate surface, not part of the panel API; see [UI extension tiers](#ui-extension-tiers)). |
| `deliveryProvider` | `Record<channelName, DeliveryProvider>` | Registering the same channel twice in one process is a loud conflict error, not last-one-wins. `send()` is retried only after it rejects; deduplicate on `queueRowId` (the idempotency key, see [authoring.md](authoring.md#delivery-providers-delivery-semantics)). |

## UI extension tiers

There are two ways for extension-supplied UI to reach the user. They are not interchangeable. Only
the first exists today, and it is deprecated and frozen; the second is the planned forward path.

| Tier | Status | What it is |
|---|---|---|
| **Legacy runtime UI extension API (HTML panels)** | **Deprecated and frozen.** No new features or fixes. Kept until it is replaced or removed. Security issues are resolved by replacing or removing the affected functionality, not by patching it. | The `ui-panel` capability. `uiPanel.onRenderPanel()` returns an HTML string (`UIPanelResult`); the host sanitizes it with DOMPurify and renders it inline under `/extensions/panels/<slot>/...` for the slots declared in `uiPanelSlots`. Panel controls post typed actions through `moduleActions`/`data-pv-action`. The host treats panel HTML as untrusted output and confines it to its slot. Do not start new UI work on this tier. |
| **First-party trusted composition** | **Planned, not built.** The forward path for extension UI. | A first-party UI package of Svelte components and SvelteKit route modules, plus a manifest, composed into a dedicated web image at build time by a Project Vault-owned Vite/SvelteKit plugin and component registry. Target capabilities: override any page, including its server `load` and form `actions`; add routes at any path; inject components at named injection points in native pages; replace individual components by name; fully customize navigation (add, remove, hide, rename, reorder, nest, including native items); theme through Project Vault's theme tokens. The package is reviewed to the same bar as Project Vault's own UI, and nothing at the boundary sanitizes, CSP-restricts, iframes or slot-confines it. Project Vault's own image stays free of it. |

`navItems` and `moduleDataRoutes` are separate extension surfaces, not part of either tier, and
neither needs a capability declaration. Both are deprecated and frozen (no new features or
fixes; kept until removed; security issues resolved by replacement or removal), each in its own
right:

- `navItems` adds append-only navigation entries to Project Vault's shell. Its forward path is
  build-time UI composition navigation (the composition tier's add, remove, hide, rename, reorder
  and nest operations over native items).
- `moduleDataRoutes`/`moduleData` mount `GET` routes on Project Vault's own API router under
  `/api/v1/extensions/data`. Its forward path is first-party API route composition (adding,
  overriding and wrapping API routes inside the host's own security pipeline).

Both stay in place until they are removed, after their replacements ship.

**Removal schedule (Story 68.11, `@project-vault/extension-api` 3.30.0).** These surfaces are now formally deprecated: `@deprecated` markers on every exported symbol and manifest field, and a `### Deprecated` entry in the package CHANGELOG. Nothing is removed and nothing changes at runtime. Removal happens no earlier than the next major (4.0.0 at time of writing) and only after the notice window ends on 2027-01-14 (projected: clock not started, the 90 days run from the day 3.30.0 is published). Replacements: composed UI (ADR 0007 build-time composition) for the panel API; the M5 nav delta of the UI pack for `navItems`; M7 `apiRoutes` for `moduleDataRoutes`/`moduleData`; `ExtensionRequestContext` and `ExtensionActionResult` for `ModuleActionContext` and `ActionResult`.

## Host services

`hooksFactory` may declare one parameter, `host: HostServices`, to call back into Project Vault. A
factory declaring zero parameters stays valid, so new services are always additive.

| Service | Method(s) | Purpose |
|---|---|---|
| `auditEventSource` | `writeAuditEvent(input)` | Write a tamper-evident audit row, namespaced `ext.<your-manifest-name>.*`. The host does the HMAC signing and key versioning; no key material or transaction handle crosses the boundary. Pass an optional `idempotencyKey` (3.26.0+) to make retries safe: a replay returns the original receipt instead of writing a second row. |
| `orgAuthorization` | `checkMembership()` | Is this identity a member of the current organization at this role or above. |
| `projectAuthorization` | `checkProjectMembership()` | The project-scoped sibling, reusing Project Vault's own effective-project-role semantics (org owner/admin bypass, explicit membership-row fallback). |
| `ephemeralState` | key/value read/write | Short-lived, org-scoped state. Resolves the current request's organization at call time. |
| `monitoring` | eight methods | Project Vault's monitoring surface. Six resolve the current request's organization at call time; two take an explicit `organizationId` because they run outside any request. |
| `notificationOriginator` | `enqueueNotification()`, `enqueueNotificationForOrg()` | Enqueue through Project Vault's own notification queue. `enqueueNotification()` is in-request only; `enqueueNotificationForOrg()` is its out-of-request sibling (explicit `organizationId`, own independent rate-limit budget). Not gated by the unrelated `notification-channel` capability. Delivery is dispatched right after the enqueue commits; if that dispatch is unavailable, the periodic catch-up delivers it within about 15 minutes (currently a 10-minute cron plus a 5-minute grace). |

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
| `mock-ui-panel-extension` | `uiPanel` and declared slots (legacy runtime UI extension API; deprecated and frozen) |
