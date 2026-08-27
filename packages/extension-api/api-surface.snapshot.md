# @project-vault/extension-api public type surface

Generated from `src/index.ts`; update this file and classify the change against the policy when the contract changes.

## export `ActionResult`

- since: 3.3.0
- kind: type
- type: `ActionResult`
- union-members: `{ outcome: "ok"; html?: string; message?: string; }`, `{ outcome: "validation_failed"; message: string; }`, `{ outcome: "denied"; message?: string; }`, `{ outcome: "conflict"; message?: string; }`, `{ outcome: "error"; }`

## export `AuditEventSourceHost`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceHost`
- member: `writeAuditEvent`
  - since: 1.0.0
  - type: `(input: AuditEventSourceWriteInput) => Promise<AuditEventSourceWriteResult>`
  - call-signature: `(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>`

## export `AuditEventSourceWriteInput`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceWriteInput`
- member: `eventType`
  - since: 1.0.0
  - type: `string`
- member: `orgId`
  - since: 1.0.0
  - type: `string`
- member: `payload`
  - since: 1.0.0
  - type: `Record<string, unknown>`
  - index-signature: `[string]: unknown`
    - since: 1.4.0
- member: `projectId?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `resourceId?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `resourceType?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `AuditEventSourceWriteResult`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceWriteResult`
- member: `createdAt`
  - since: 1.0.0
  - type: `string`
- member: `id`
  - since: 1.0.0
  - type: `string`

## export `AuthResult`

- since: 1.0.0
- kind: type
- type: `AuthResult`
- member: `displayName?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `email?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `externalSubject`
  - since: 1.0.0
  - type: `string`
- member: `providerName`
  - since: 1.0.0
  - type: `string`

## export `AuthStrategy`

- since: 1.0.0
- kind: type
- type: `AuthStrategy`
- member: `onAuthenticate`
  - since: 1.0.0
  - type: `(credential: string) => Promise<AuthResult>`
  - call-signature: `(credential: string): Promise<AuthResult>`

## export `CapabilityDecision`

- since: 1.0.0
- kind: type
- type: `CapabilityDecision`
- union-members: `{ permitted: true; }`, `{ permitted: false; reasonCode: string; message?: string; }`

## export `CapabilityGate`

- since: 1.0.0
- kind: type
- type: `CapabilityGate`
- member: `onCheckCapability`
  - since: 1.0.0
  - type: `(context: CapabilityGateContext) => Promise<CapabilityDecision>`
  - call-signature: `(context: CapabilityGateContext): Promise<CapabilityDecision>`

## export `CapabilityGateContext`

- since: 1.0.0
- kind: type
- type: `CapabilityGateContext`
- member: `capability`
  - since: 1.0.0
  - type: `string`
- member: `gateCallId`
  - since: 1.0.0
  - type: `string`
- member: `orgId`
  - since: 1.0.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `orgRole`
  - since: 1.0.0
  - type: `"owner" | "admin" | "member" | "viewer" | null`
  - union-members: `null`, `"owner"`, `"admin"`, `"member"`, `"viewer"`
- member: `userId`
  - since: 1.0.0
  - type: `string | null`
  - union-members: `null`, `string`

## export `defineExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest) => ExtensionManifest`
- call-signature: `(manifest: ExtensionManifest): ExtensionManifest`

## export `EphemeralStateHost`

- since: 3.7.0
- kind: type
- type: `EphemeralStateHost`
- member: `compareAndDelete`
  - since: 3.7.0
  - type: `(key: string, expectedValue: string) => Promise<boolean>`
  - call-signature: `(key: string, expectedValue: string): Promise<boolean>`
- member: `compareAndSwap`
  - since: 3.7.0
  - type: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number) => Promise<boolean>`
  - call-signature: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number): Promise<boolean>`
- member: `delete`
  - since: 3.7.0
  - type: `(key: string) => Promise<void>`
  - call-signature: `(key: string): Promise<void>`
- member: `get`
  - since: 3.7.0
  - type: `(key: string) => Promise<string | undefined>`
  - call-signature: `(key: string): Promise<string | undefined>`
- member: `set`
  - since: 3.7.0
  - type: `(key: string, value: string, ttlSeconds: number) => Promise<void>`
  - call-signature: `(key: string, value: string, ttlSeconds: number): Promise<void>`

## export `EXTENSION_API_VERSION`

- since: 1.0.0
- kind: value
- type: `"3.7.0"`

## export `EXTENSION_THEME_CSS_VARS`

- since: 3.3.0
- kind: value
- type: `readonly ["--pv-ext-surface", "--pv-ext-ink", "--pv-ext-muted", "--pv-ext-brand", "--pv-ext-line"]`

## export `ExtensionCapability`

- since: 1.0.0
- kind: type
- type: `ExtensionCapability`
- union-members: `"auth-provider"`, `"notification-channel"`, `"ui-panel"`, `"capability-gate"`, `"audit-event-source"`, `"project-lifecycle"`

## export `ExtensionDbHandle`

- since: 2.0.0
- kind: type
- type: `ExtensionDbHandle`
- member: `query`
  - since: 2.0.0
  - type: `<T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>`
  - call-signature: `<T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>`
- member: `transaction`
  - since: 2.0.0
  - type: `<T>(callback: (tx: ExtensionDbHandle) => Promise<T>) => Promise<T>`
  - call-signature: `<T>(callback: (tx: ExtensionDbHandle) => Promise<T>): Promise<T>`

## export `ExtensionDbOperation`

- since: 2.0.0
- kind: type
- type: `ExtensionDbOperation`
- union-members: `"select"`, `"insert"`, `"update"`, `"delete"`

## export `ExtensionDbScopeEntry`

- since: 2.0.0
- kind: type
- type: `ExtensionDbScopeEntry`
- member: `operations`
  - since: 2.0.0
  - type: `ExtensionDbOperation[]`
- member: `table`
  - since: 2.0.0
  - type: `string`

## export `ExtensionDbUnavailableReason`

- since: 2.0.0
- kind: type
- type: `ExtensionDbUnavailableReason`
- union-members: `"not-configured"`, `"no-approved-scope"`

## export `ExtensionHooks`

- since: 1.0.0
- kind: type
- type: `ExtensionHooks`
- member: `authStrategy?`
  - since: 1.0.0
  - type: `AuthStrategy | undefined`
  - union-members: `undefined`, `AuthStrategy`
- member: `capabilityGate?`
  - since: 1.0.0
  - type: `CapabilityGate | undefined`
  - union-members: `undefined`, `CapabilityGate`
- member: `moduleAction?`
  - since: 3.3.0
  - type: `ModuleAction | undefined`
  - union-members: `undefined`, `ModuleAction`
- member: `notificationChannel?`
  - since: 1.0.0
  - type: `NotificationChannel | undefined`
  - union-members: `undefined`, `NotificationChannel`
- member: `projectLifecycle?`
  - since: 2.1.0
  - type: `ProjectCreatePolicy | undefined`
  - union-members: `undefined`, `ProjectCreatePolicy`
- member: `uiPanel?`
  - since: 1.0.0
  - type: `UIPanel | undefined`
  - union-members: `undefined`, `UIPanel`

## export `ExtensionManifest`

- since: 1.0.0
- kind: type
- type: `ExtensionManifest`
- member: `apiVersion`
  - since: 1.0.0
  - type: `string`
- member: `capabilities`
  - since: 1.0.0
  - type: `ExtensionCapability[]`
- member: `dbScope?`
  - since: 2.0.0
  - type: `ExtensionDbScopeEntry[] | undefined`
  - union-members: `undefined`, `ExtensionDbScopeEntry[]`
- member: `moduleActions?`
  - since: 3.3.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`
- member: `name`
  - since: 1.0.0
  - type: `string`
- member: `replacesNativeLogin?`
  - since: 1.0.0
  - type: `boolean | undefined`
  - union-members: `undefined`, `false`, `true`
- member: `uiPanelSlots?`
  - since: 3.1.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`

## export `ExtensionRegistrationError`

- since: 1.0.0
- kind: type
- type: `ExtensionRegistrationError`
- member: `cause?`
  - since: 1.0.0
  - type: `unknown`
- member: `message`
  - since: 1.0.0
  - type: `string`
- member: `name`
  - since: 1.0.0
  - type: `string`
- member: `readonly reason`
  - since: 1.0.0
  - type: `ExtensionRegistrationErrorReason`
  - union-members: `"invalid-name"`, `"incompatible-version"`, `"invalid-manifest-field"`, `"invalid-db-scope"`
- member: `stack?`
  - since: 1.0.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `ExtensionRegistrationErrorReason`

- since: 1.0.0
- kind: type
- type: `ExtensionRegistrationErrorReason`
- union-members: `"invalid-name"`, `"incompatible-version"`, `"invalid-manifest-field"`, `"invalid-db-scope"`

## export `ExtensionRuntimeContext`

- since: 2.0.0
- kind: type
- type: `ExtensionRuntimeContext`
- member: `getDbHandle`
  - since: 2.0.0
  - type: `() => Promise<ExtensionDbHandle | { unavailable: ExtensionDbUnavailableReason; }>`
  - call-signature: `(): Promise<ExtensionDbHandle | { unavailable: ExtensionDbUnavailableReason; }>`

## export `ExtensionThemeCssVar`

- since: 3.3.0
- kind: type
- type: `"--pv-ext-surface" | "--pv-ext-ink" | "--pv-ext-muted" | "--pv-ext-brand" | "--pv-ext-line"`
- union-members: `"--pv-ext-surface"`, `"--pv-ext-ink"`, `"--pv-ext-muted"`, `"--pv-ext-brand"`, `"--pv-ext-line"`

## export `HOST_SUPPORTED_EXTENSION_API_RANGE`

- since: 1.0.0
- kind: value
- type: `string`

## export `HostServices`

- since: 1.0.0
- kind: type
- type: `HostServices`
- member: `auditEventSource`
  - since: 1.0.0
  - type: `AuditEventSourceHost`
  - member: `writeAuditEvent`
    - since: 1.0.0
    - type: `(input: AuditEventSourceWriteInput) => Promise<AuditEventSourceWriteResult>`
    - call-signature: `(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>`
- member: `ephemeralState`
  - since: 3.7.0
  - type: `EphemeralStateHost`
  - member: `compareAndDelete`
    - since: 3.7.0
    - type: `(key: string, expectedValue: string) => Promise<boolean>`
    - call-signature: `(key: string, expectedValue: string): Promise<boolean>`
  - member: `compareAndSwap`
    - since: 3.7.0
    - type: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number) => Promise<boolean>`
    - call-signature: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number): Promise<boolean>`
  - member: `delete`
    - since: 3.7.0
    - type: `(key: string) => Promise<void>`
    - call-signature: `(key: string): Promise<void>`
  - member: `get`
    - since: 3.7.0
    - type: `(key: string) => Promise<string | undefined>`
    - call-signature: `(key: string): Promise<string | undefined>`
  - member: `set`
    - since: 3.7.0
    - type: `(key: string, value: string, ttlSeconds: number) => Promise<void>`
    - call-signature: `(key: string, value: string, ttlSeconds: number): Promise<void>`
- member: `orgAuthorization`
  - since: 2.2.0
  - type: `OrgAuthorizationHost`
  - member: `checkMembership`
    - since: 2.2.0
    - type: `(context: OrgAuthorizationCheckContext) => Promise<OrgAuthorizationOutcome>`
    - call-signature: `(context: OrgAuthorizationCheckContext): Promise<OrgAuthorizationOutcome>`

## export `isExtensionApiVersionSupported`

- since: 1.0.0
- kind: value
- type: `(declaredApiVersion: string) => boolean`
- call-signature: `(declaredApiVersion: string): boolean`

## export `MAX_MODULE_ACTIONS`

- since: 3.3.0
- kind: value
- type: `32`

## export `MAX_UI_PANEL_SLOTS`

- since: 3.1.0
- kind: value
- type: `32`

## export `MODULE_ACTION_NAME_PATTERN`

- since: 3.3.0
- kind: value
- type: `RegExp`
- member: `__@match@469`
  - since: 3.6.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@478`
  - since: 3.6.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@471`
  - since: 3.6.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@474`
  - since: 3.6.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@476`
  - since: 3.6.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.3.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.3.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.3.0
  - type: `string`
- member: `readonly global`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.3.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.3.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.3.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.3.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `ModuleAction`

- since: 3.3.0
- kind: type
- type: `ModuleAction`
- member: `onAction`
  - since: 3.3.0
  - type: `(context: ModuleActionContext, request: ModuleActionRequest) => Promise<ActionResult>`
  - call-signature: `(context: ModuleActionContext, request: ModuleActionRequest): Promise<ActionResult>`

## export `ModuleActionContext`

- since: 3.3.0
- kind: type
- type: `UIPanelContext`
- member: `actionEndpoint?`
  - since: 3.3.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `identity`
  - since: 3.3.0
  - type: `{ userId: string; orgRole: "owner" | "admin" | "member" | "viewer"; }`
  - member: `orgRole`
    - since: 3.3.0
    - type: `"owner" | "admin" | "member" | "viewer"`
    - union-members: `"owner"`, `"admin"`, `"member"`, `"viewer"`
  - member: `userId`
    - since: 3.3.0
    - type: `string`
- member: `locale`
  - since: 3.3.0
  - type: `"en" | "es"`
  - union-members: `"en"`, `"es"`
- member: `orgId`
  - since: 3.3.0
  - type: `string`
- member: `projectId?`
  - since: 3.3.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `resourceId?`
  - since: 3.3.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `slot`
  - since: 3.3.0
  - type: `string`
- member: `subpath?`
  - since: 3.5.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `theme`
  - since: 3.3.0
  - type: `{ name: string | null; }`
  - member: `name`
    - since: 3.3.0
    - type: `string | null`
    - union-members: `null`, `string`

## export `ModuleActionRequest`

- since: 3.3.0
- kind: type
- type: `ModuleActionRequest`
- member: `action`
  - since: 3.3.0
  - type: `Record<string, unknown> & { kind: string; }`
  - intersection-members: `Record<string, unknown>`, `{ kind: string; }`

## export `NotificationChannel`

- since: 1.0.0
- kind: type
- type: `NotificationChannel`
- member: `onNotify`
  - since: 1.0.0
  - type: `(payload: NotificationPayload) => Promise<void>`
  - call-signature: `(payload: NotificationPayload): Promise<void>`

## export `NotificationPayload`

- since: 1.0.0
- kind: type
- type: `NotificationPayload`
- member: `body`
  - since: 1.0.0
  - type: `string`
- member: `subject`
  - since: 1.0.0
  - type: `string`

## export `OrgAuthorizationCheckContext`

- since: 2.2.0
- kind: type
- type: `OrgAuthorizationCheckContext`
- member: `minimumRole`
  - since: 2.2.0
  - type: `"owner" | "admin" | "member" | "viewer"`
  - union-members: `"owner"`, `"admin"`, `"member"`, `"viewer"`
- member: `viewerIdentityId`
  - since: 2.2.0
  - type: `string`

## export `OrgAuthorizationHost`

- since: 2.2.0
- kind: type
- type: `OrgAuthorizationHost`
- member: `checkMembership`
  - since: 2.2.0
  - type: `(context: OrgAuthorizationCheckContext) => Promise<OrgAuthorizationOutcome>`
  - call-signature: `(context: OrgAuthorizationCheckContext): Promise<OrgAuthorizationOutcome>`

## export `OrgAuthorizationOutcome`

- since: 2.2.0
- kind: type
- type: `OrgAuthorizationOutcome`
- union-members: `{ outcome: "authorized"; }`, `{ outcome: "denied"; reasonCode: string; }`, `{ outcome: "error"; reasonCode: string; }`

## export `ProjectCreateDecision`

- since: 2.1.0
- kind: type
- type: `ProjectCreateDecision`
- union-members: `{ permitted: true; }`, `{ permitted: false; reasonCode: string; message?: string; }`

## export `ProjectCreatePolicy`

- since: 2.1.0
- kind: type
- type: `ProjectCreatePolicy`
- member: `onBeforeCreateProject`
  - since: 2.1.0
  - type: `(context: ProjectCreatePolicyContext) => Promise<ProjectCreateDecision>`
  - call-signature: `(context: ProjectCreatePolicyContext): Promise<ProjectCreateDecision>`

## export `ProjectCreatePolicyContext`

- since: 2.1.0
- kind: type
- type: `ProjectCreatePolicyContext`
- member: `actorUserId`
  - since: 2.1.0
  - type: `string`
- member: `creationRequestId`
  - since: 2.1.0
  - type: `string`
- member: `currentProjectCount`
  - since: 2.1.0
  - type: `number`
- member: `organizationId`
  - since: 2.1.0
  - type: `string`
- member: `projectName`
  - since: 2.1.0
  - type: `string`

## export `registerExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest, hooksFactory: (context: ExtensionRuntimeContext & HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: ExtensionRuntimeContext & HostServices) => { manifest: ExtensionManifest; hooks: ExtensionHooks; }`
- call-signature: `(manifest: ExtensionManifest, hooksFactory: (context: ExtensionRuntimeContext & HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: ExtensionRuntimeContext & HostServices): { manifest: ExtensionManifest; hooks: ExtensionHooks; }`

## export `UI_PANEL_SLOT_NAME_PATTERN`

- since: 3.1.0
- kind: value
- type: `RegExp`
- member: `__@match@469`
  - since: 3.6.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@478`
  - since: 3.6.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@471`
  - since: 3.6.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@474`
  - since: 3.6.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@476`
  - since: 3.6.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.1.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.1.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.1.0
  - type: `string`
- member: `readonly global`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.1.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.1.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.1.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.1.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `UIPanel`

- since: 1.0.0
- kind: type
- type: `UIPanel`
- member: `onRenderPanel`
  - since: 1.0.0
  - type: `(context: UIPanelContext) => Promise<UIPanelResult>`
  - call-signature: `(context: UIPanelContext): Promise<UIPanelResult>`

## export `UIPanelContext`

- since: 1.0.0
- kind: type
- type: `UIPanelContext`
- member: `actionEndpoint?`
  - since: 3.3.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `identity`
  - since: 3.2.0
  - type: `{ userId: string; orgRole: "owner" | "admin" | "member" | "viewer"; }`
  - member: `orgRole`
    - since: 3.2.0
    - type: `"owner" | "admin" | "member" | "viewer"`
    - union-members: `"owner"`, `"admin"`, `"member"`, `"viewer"`
  - member: `userId`
    - since: 3.2.0
    - type: `string`
- member: `locale`
  - since: 3.2.0
  - type: `"en" | "es"`
  - union-members: `"en"`, `"es"`
- member: `orgId`
  - since: 3.2.0
  - type: `string`
- member: `projectId?`
  - since: 3.2.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `resourceId?`
  - since: 3.2.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `slot`
  - since: 1.0.0
  - type: `string`
- member: `subpath?`
  - since: 3.5.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `theme`
  - since: 3.2.0
  - type: `{ name: string | null; }`
  - member: `name`
    - since: 3.2.0
    - type: `string | null`
    - union-members: `null`, `string`

## export `UIPanelResult`

- since: 1.0.0
- kind: type
- type: `UIPanelResult`
- member: `html`
  - since: 1.0.0
  - type: `string`
