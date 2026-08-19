# @project-vault/extension-api public type surface

Generated from `src/index.ts`; update this file and classify the change against the policy when the contract changes.

## export `AuditEventSourceHost`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceHost`
- member: `writeAuditEvent`
  - since: 1.0.0
  - call-signature: `(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>`

## export `AuditEventSourceWriteInput`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceWriteInput`
- member: `eventType`
  - since: 1.0.0
- member: `orgId`
  - since: 1.0.0
- member: `payload`
  - since: 1.0.0
- member: `projectId?`
  - since: 1.0.0
  - union-members: `undefined`, `string`
- member: `resourceId?`
  - since: 1.0.0
  - union-members: `undefined`, `string`
- member: `resourceType?`
  - since: 1.0.0
  - union-members: `undefined`, `string`

## export `AuditEventSourceWriteResult`

- since: 1.0.0
- kind: type
- type: `AuditEventSourceWriteResult`
- member: `createdAt`
  - since: 1.0.0
- member: `id`
  - since: 1.0.0

## export `AuthResult`

- since: 1.0.0
- kind: type
- type: `AuthResult`
- member: `displayName?`
  - since: 1.0.0
  - union-members: `undefined`, `string`
- member: `email?`
  - since: 1.0.0
  - union-members: `undefined`, `string`
- member: `externalSubject`
  - since: 1.0.0
- member: `providerName`
  - since: 1.0.0

## export `AuthStrategy`

- since: 1.0.0
- kind: type
- type: `AuthStrategy`
- member: `onAuthenticate`
  - since: 1.0.0
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
  - call-signature: `(context: CapabilityGateContext): Promise<CapabilityDecision>`

## export `CapabilityGateContext`

- since: 1.0.0
- kind: type
- type: `CapabilityGateContext`
- member: `capability`
  - since: 1.0.0
- member: `gateCallId`
  - since: 1.0.0
- member: `orgId`
  - since: 1.0.0
  - union-members: `null`, `string`
- member: `orgRole`
  - since: 1.0.0
  - union-members: `null`, `"owner"`, `"admin"`, `"member"`, `"viewer"`
- member: `userId`
  - since: 1.0.0
  - union-members: `null`, `string`

## export `defineExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest) => ExtensionManifest`
- call-signature: `(manifest: ExtensionManifest): ExtensionManifest`

## export `EXTENSION_API_VERSION`

- since: 1.0.0
- kind: value
- type: `"1.4.0"`

## export `ExtensionCapability`

- since: 1.0.0
- kind: type
- type: `ExtensionCapability`
- union-members: `"auth-provider"`, `"notification-channel"`, `"ui-panel"`, `"capability-gate"`, `"audit-event-source"`

## export `ExtensionHooks`

- since: 1.0.0
- kind: type
- type: `ExtensionHooks`
- member: `authStrategy?`
  - since: 1.0.0
  - union-members: `undefined`, `AuthStrategy`
- member: `capabilityGate?`
  - since: 1.0.0
  - union-members: `undefined`, `CapabilityGate`
- member: `notificationChannel?`
  - since: 1.0.0
  - union-members: `undefined`, `NotificationChannel`
- member: `uiPanel?`
  - since: 1.0.0
  - union-members: `undefined`, `UIPanel`

## export `ExtensionManifest`

- since: 1.0.0
- kind: type
- type: `ExtensionManifest`
- member: `apiVersion`
  - since: 1.0.0
- member: `capabilities`
  - since: 1.0.0
- member: `name`
  - since: 1.0.0
- member: `replacesNativeLogin?`
  - since: 1.0.0
  - union-members: `undefined`, `false`, `true`

## export `ExtensionRegistrationError`

- since: 1.0.0
- kind: type
- type: `ExtensionRegistrationError`
- member: `cause?`
  - since: 1.0.0
- member: `message`
  - since: 1.0.0
- member: `name`
  - since: 1.0.0
- member: `reason`
  - since: 1.0.0
  - union-members: `"invalid-name"`, `"incompatible-version"`, `"invalid-manifest-field"`
- member: `stack?`
  - since: 1.0.0
  - union-members: `undefined`, `string`

## export `ExtensionRegistrationErrorReason`

- since: 1.0.0
- kind: type
- type: `ExtensionRegistrationErrorReason`
- union-members: `"invalid-name"`, `"incompatible-version"`, `"invalid-manifest-field"`

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
  - member: `writeAuditEvent`
    - since: 1.0.0
    - call-signature: `(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>`

## export `isExtensionApiVersionSupported`

- since: 1.0.0
- kind: value
- type: `(declaredApiVersion: string) => boolean`
- call-signature: `(declaredApiVersion: string): boolean`

## export `NotificationChannel`

- since: 1.0.0
- kind: type
- type: `NotificationChannel`
- member: `onNotify`
  - since: 1.0.0
  - call-signature: `(payload: NotificationPayload): Promise<void>`

## export `NotificationPayload`

- since: 1.0.0
- kind: type
- type: `NotificationPayload`
- member: `body`
  - since: 1.0.0
- member: `subject`
  - since: 1.0.0

## export `registerExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest, hooksFactory: (host: HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: HostServices) => { manifest: ExtensionManifest; hooks: ExtensionHooks; }`
- call-signature: `(manifest: ExtensionManifest, hooksFactory: (host: HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: HostServices): { manifest: ExtensionManifest; hooks: ExtensionHooks; }`

## export `UIPanel`

- since: 1.0.0
- kind: type
- type: `UIPanel`
- member: `onRenderPanel`
  - since: 1.0.0
  - call-signature: `(context: UIPanelContext): Promise<UIPanelResult>`

## export `UIPanelContext`

- since: 1.0.0
- kind: type
- type: `UIPanelContext`
- member: `slot`
  - since: 1.0.0

## export `UIPanelResult`

- since: 1.0.0
- kind: type
- type: `UIPanelResult`
- member: `html`
  - since: 1.0.0
