# @project-vault/extension-api public type surface

Generated from `src/index.ts`; update this file and classify the change against the policy when the contract changes.

## export `ActionResult`

- since: 3.3.0
- kind: type
- type: `ActionResult`
- union-members: `{ outcome: "ok"; html?: string; message?: string; }`, `{ outcome: "validation_failed"; message: string; html?: string; }`, `{ outcome: "denied"; message?: string; html?: string; }`, `{ outcome: "conflict"; message?: string; html?: string; }`, `{ outcome: "error"; html?: string; }`

## export `ANONYMOUS_ROUTE_PATH_PATTERN`

- since: 3.23.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.23.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.23.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.23.0
  - type: `string`
- member: `readonly global`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.23.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.23.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.23.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.23.0
  - type: `boolean`
  - union-members: `false`, `true`

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

## export `CredentialShareCreationErrorStatus`

- since: 3.22.0
- kind: type
- type: `CredentialShareCreationErrorStatus`
- union-members: `{ status: "credential_not_found"; }`, `{ status: "credential_archived"; }`, `{ status: "unknown_field_key"; field: string; }`, `{ status: "ambiguous_share_scope"; }`, `{ status: "too_many_attribute_keys"; }`, `{ status: "expires_at_invalid"; reason: "past" | "too_far_in_future"; }`, `{ status: "cap_exceeded"; }`

## export `CredentialSharingCreateExternalShareParams`

- since: 3.22.0
- kind: type
- type: `CredentialSharingCreateExternalShareParams`
- member: `attributeKeys?`
  - since: 3.22.0
  - type: `string[] | null | undefined`
  - union-members: `undefined`, `null`, `string[]`
- member: `credentialId`
  - since: 3.22.0
  - type: `string`
- member: `expiresAt`
  - since: 3.22.0
  - type: `string`
- member: `fieldKey?`
  - since: 3.22.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `organizationId`
  - since: 3.22.0
  - type: `string`
- member: `projectId`
  - since: 3.22.0
  - type: `string`
- member: `recipientEmail`
  - since: 3.22.0
  - type: `string`

## export `CredentialSharingCreateExternalShareResult`

- since: 3.22.0
- kind: type
- type: `CredentialSharingCreateExternalShareResult`
- union-members: `{ status: "credential_not_found"; }`, `{ status: "credential_archived"; }`, `{ status: "unknown_field_key"; field: string; }`, `{ status: "ambiguous_share_scope"; }`, `{ status: "too_many_attribute_keys"; }`, `{ status: "expires_at_invalid"; reason: "past" | "too_far_in_future"; }`, `{ status: "cap_exceeded"; }`, `{ status: "ok"; share: CredentialSharingShareRecord; token: string; }`

## export `CredentialSharingFindShareByTokenResult`

- since: 3.22.0
- kind: type
- type: `CredentialSharingFindShareByTokenResult`
- union-members: `{ status: "not_found"; }`, `{ status: "ok"; share: CredentialSharingShareRecord; credentialName: string; credentialProjectId: string; sharedByDisplayName: string; }`

## export `CredentialSharingHost`

- since: 3.22.0
- kind: type
- type: `CredentialSharingHost`
- member: `createExternalShare`
  - since: 3.22.0
  - type: `(params: CredentialSharingCreateExternalShareParams) => Promise<CredentialSharingCreateExternalShareResult>`
  - call-signature: `(params: CredentialSharingCreateExternalShareParams): Promise<CredentialSharingCreateExternalShareResult>`
- member: `findShareByToken`
  - since: 3.22.0
  - type: `(rawToken: string) => Promise<CredentialSharingFindShareByTokenResult>`
  - call-signature: `(rawToken: string): Promise<CredentialSharingFindShareByTokenResult>`
- member: `listSharesForCredential`
  - since: 3.23.0
  - type: `(params: CredentialSharingListParams) => Promise<CredentialSharingListResult>`
  - call-signature: `(params: CredentialSharingListParams): Promise<CredentialSharingListResult>`
- member: `listSharesForOrganization`
  - since: 3.23.0
  - type: `(params: CredentialSharingOrgListParams) => Promise<CredentialSharingListResult>`
  - call-signature: `(params: CredentialSharingOrgListParams): Promise<CredentialSharingListResult>`
- member: `revealShare`
  - since: 3.22.0
  - type: `(rawToken: string) => Promise<CredentialSharingRevealResult>`
  - call-signature: `(rawToken: string): Promise<CredentialSharingRevealResult>`
- member: `revokeShare`
  - since: 3.22.0
  - type: `(params: CredentialSharingRevokeShareParams) => Promise<CredentialSharingRevokeShareResult>`
  - call-signature: `(params: CredentialSharingRevokeShareParams): Promise<CredentialSharingRevokeShareResult>`
- member: `supersedeSharesForRotation`
  - since: 3.22.0
  - type: `(params: CredentialSharingSupersedeSharesForRotationParams) => Promise<CredentialSharingSupersedeSharesForRotationResult>`
  - call-signature: `(params: CredentialSharingSupersedeSharesForRotationParams): Promise<CredentialSharingSupersedeSharesForRotationResult>`

## export `CredentialSharingListParams`

- since: 3.23.0
- kind: type
- type: `CredentialSharingListParams`
- member: `credentialId`
  - since: 3.23.0
  - type: `string`
- member: `limit?`
  - since: 3.23.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`
- member: `offset?`
  - since: 3.23.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`
- member: `organizationId`
  - since: 3.23.0
  - type: `string`
- member: `status?`
  - since: 3.23.0
  - type: `CredentialSharingShareStatus | undefined`
  - union-members: `undefined`, `"active"`, `"viewed"`, `"revoked"`, `"expired"`, `"superseded"`

## export `CredentialSharingListResult`

- since: 3.23.0
- kind: type
- type: `CredentialSharingListResult`
- member: `items`
  - since: 3.23.0
  - type: `CredentialSharingShareRecord[]`
- member: `status`
  - since: 3.23.0
  - type: `"ok"`
- member: `total`
  - since: 3.23.0
  - type: `number`

## export `CredentialSharingNoMachineUserError`

- since: 3.22.0
- kind: type
- type: `CredentialSharingNoMachineUserError`
- member: `cause?`
  - since: 3.22.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.22.0
  - type: `"credential_sharing_no_machine_user"`
- member: `message`
  - since: 3.22.0
  - type: `string`
- member: `name`
  - since: 3.22.0
  - type: `string`
- member: `stack?`
  - since: 3.22.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `CredentialSharingOrgListParams`

- since: 3.23.0
- kind: type
- type: `CredentialSharingOrgListParams`
- member: `limit?`
  - since: 3.23.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`
- member: `offset?`
  - since: 3.23.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`
- member: `organizationId`
  - since: 3.23.0
  - type: `string`
- member: `status?`
  - since: 3.23.0
  - type: `CredentialSharingShareStatus | undefined`
  - union-members: `undefined`, `"active"`, `"viewed"`, `"revoked"`, `"expired"`, `"superseded"`

## export `CredentialSharingOrgRateLimitedError`

- since: 3.22.0
- kind: type
- type: `CredentialSharingOrgRateLimitedError`
- member: `cause?`
  - since: 3.22.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.22.0
  - type: `"credential_sharing_org_rate_limited"`
- member: `message`
  - since: 3.22.0
  - type: `string`
- member: `name`
  - since: 3.22.0
  - type: `string`
- member: `stack?`
  - since: 3.22.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `CredentialSharingRateLimitedError`

- since: 3.22.0
- kind: type
- type: `CredentialSharingRateLimitedError`
- member: `cause?`
  - since: 3.22.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.22.0
  - type: `"credential_sharing_rate_limited"`
- member: `message`
  - since: 3.22.0
  - type: `string`
- member: `name`
  - since: 3.22.0
  - type: `string`
- member: `stack?`
  - since: 3.22.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `CredentialSharingRevealResult`

- since: 3.22.0
- kind: type
- type: `CredentialSharingRevealResult`
- union-members: `{ status: "not_found"; }`, `{ status: "expired"; }`, `{ status: "already_viewed"; }`, `{ status: "revoked"; }`, `{ status: "ok"; share: CredentialSharingShareRecord; value: string; valueFormat: "scalar" | "fields"; fieldKey: string | null; }`

## export `CredentialSharingRevokeShareParams`

- since: 3.22.0
- kind: type
- type: `CredentialSharingRevokeShareParams`
- member: `credentialId`
  - since: 3.22.0
  - type: `string`
- member: `organizationId`
  - since: 3.22.0
  - type: `string`
- member: `projectId`
  - since: 3.22.0
  - type: `string`
- member: `shareId`
  - since: 3.22.0
  - type: `string`

## export `CredentialSharingRevokeShareResult`

- since: 3.22.0
- kind: type
- type: `CredentialSharingRevokeShareResult`
- union-members: `{ status: "not_found"; }`, `{ status: "ok"; share: CredentialSharingShareRecord; alreadyTerminal: boolean; }`

## export `CredentialSharingShareRecord`

- since: 3.22.0
- kind: type
- type: `CredentialSharingShareRecord`
- member: `attributeKeys`
  - since: 3.22.0
  - type: `string[] | null`
  - union-members: `null`, `string[]`
- member: `createdAt`
  - since: 3.22.0
  - type: `string`
- member: `credentialId`
  - since: 3.22.0
  - type: `string`
- member: `expiresAt`
  - since: 3.22.0
  - type: `string`
- member: `fieldKey`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `firstViewedAt`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `id`
  - since: 3.22.0
  - type: `string`
- member: `orgId`
  - since: 3.22.0
  - type: `string`
- member: `recipientEmail`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `recipientType`
  - since: 3.22.0
  - type: `"user" | "external"`
  - union-members: `"user"`, `"external"`
- member: `recipientUserId`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `revokedAt`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `singleUse`
  - since: 3.22.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `status`
  - since: 3.22.0
  - type: `CredentialSharingShareStatus`
  - union-members: `"active"`, `"viewed"`, `"revoked"`, `"expired"`, `"superseded"`
- member: `supersededAt`
  - since: 3.22.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `viewCount`
  - since: 3.22.0
  - type: `number`

## export `CredentialSharingShareStatus`

- since: 3.22.0
- kind: type
- type: `CredentialSharingShareStatus`
- union-members: `"active"`, `"viewed"`, `"revoked"`, `"expired"`, `"superseded"`

## export `CredentialSharingSupersedeSharesForRotationParams`

- since: 3.22.0
- kind: type
- type: `CredentialSharingSupersedeSharesForRotationParams`
- member: `credentialId`
  - since: 3.22.0
  - type: `string`
- member: `organizationId`
  - since: 3.22.0
  - type: `string`
- member: `rotationId`
  - since: 3.22.0
  - type: `string`
- member: `targetFields`
  - since: 3.22.0
  - type: `string[] | null`
  - union-members: `null`, `string[]`

## export `CredentialSharingSupersedeSharesForRotationResult`

- since: 3.22.0
- kind: type
- type: `CredentialSharingSupersedeSharesForRotationResult`
- member: `supersededShares`
  - since: 3.22.0
  - type: `CredentialSharingShareRecord[]`

## export `defineExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest) => ExtensionManifest`
- call-signature: `(manifest: ExtensionManifest): ExtensionManifest`

## export `DeliveryProvider`

- since: 3.11.0
- kind: type
- type: `DeliveryProvider`
- member: `parseWebhookEvents`
  - since: 3.11.0
  - type: `(rawBody: string) => DeliveryStatusEvent[]`
  - call-signature: `(rawBody: string): DeliveryStatusEvent[]`
- member: `send`
  - since: 3.11.0
  - type: `(payload: DeliveryProviderSendPayload) => Promise<DeliveryProviderSendResult>`
  - call-signature: `(payload: DeliveryProviderSendPayload): Promise<DeliveryProviderSendResult>`
- member: `verifyWebhookSignature`
  - since: 3.11.0
  - type: `(input: { rawBody: string; headers: Record<string, string | string[] | undefined>; }) => boolean`
  - call-signature: `(input: { rawBody: string; headers: Record<string, string | string[] | undefined>; }): boolean`

## export `DeliveryProviderSendPayload`

- since: 3.11.0
- kind: type
- type: `DeliveryProviderSendPayload`
- member: `body`
  - since: 3.11.0
  - type: `string`
- member: `queueRowId`
  - since: 3.11.0
  - type: `string`
- member: `recipientAddress`
  - since: 3.11.0
  - type: `string`
- member: `subject`
  - since: 3.11.0
  - type: `string`
- member: `templateId`
  - since: 3.11.0
  - type: `string`

## export `DeliveryProviderSendResult`

- since: 3.11.0
- kind: type
- type: `DeliveryProviderSendResult`
- member: `providerMessageId`
  - since: 3.11.0
  - type: `string`

## export `DeliveryStatusEvent`

- since: 3.11.0
- kind: type
- type: `DeliveryStatusEvent`
- member: `providerMessageId`
  - since: 3.11.0
  - type: `string`
- member: `status`
  - since: 3.11.0
  - type: `DeliveryStatusValue`
  - union-members: `"sent"`, `"delivered"`, `"bounced"`, `"suppressed"`, `"failed"`

## export `DeliveryStatusValue`

- since: 3.11.0
- kind: type
- type: `DeliveryStatusValue`
- union-members: `"sent"`, `"delivered"`, `"bounced"`, `"suppressed"`, `"failed"`

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
- type: `"3.24.0"`

## export `EXTENSION_THEME_CSS_VARS`

- since: 3.3.0
- kind: value
- type: `readonly ["--pv-ext-surface", "--pv-ext-ink", "--pv-ext-muted", "--pv-ext-brand", "--pv-ext-line"]`

## export `ExtensionCapability`

- since: 1.0.0
- kind: type
- type: `ExtensionCapability`
- union-members: `"auth-provider"`, `"notification-channel"`, `"ui-panel"`, `"capability-gate"`, `"audit-event-source"`, `"project-lifecycle"`, `"delivery-provider"`, `"project-archive-notify"`, `"oauth-handoff"`, `"scheduled-task"`, `"public-route"`

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
- member: `deliveryProvider?`
  - since: 3.11.0
  - type: `Record<string, DeliveryProvider> | undefined`
  - union-members: `undefined`, `Record<string, DeliveryProvider>`
- member: `moduleAction?`
  - since: 3.3.0
  - type: `ModuleAction | undefined`
  - union-members: `undefined`, `ModuleAction`
- member: `moduleData?`
  - since: 3.10.0
  - type: `Record<string, ModuleDataRouteHandler> | undefined`
  - union-members: `undefined`, `Record<string, ModuleDataRouteHandler>`
- member: `notificationChannel?`
  - since: 1.0.0
  - type: `NotificationChannel | undefined`
  - union-members: `undefined`, `NotificationChannel`
- member: `oauthHandoff?`
  - since: 3.16.0
  - type: `OAuthHandoffHooks | undefined`
  - union-members: `undefined`, `OAuthHandoffHooks`
- member: `projectArchiveNotifier?`
  - since: 3.13.0
  - type: `ProjectArchiveNotifier | undefined`
  - union-members: `undefined`, `ProjectArchiveNotifier`
- member: `projectLifecycle?`
  - since: 2.1.0
  - type: `ProjectCreatePolicy | undefined`
  - union-members: `undefined`, `ProjectCreatePolicy`
- member: `publicRoute?`
  - since: 3.23.0
  - type: `PublicRouteHooks | undefined`
  - union-members: `undefined`, `PublicRouteHooks`
- member: `scheduledTask?`
  - since: 3.18.0
  - type: `ScheduledTaskHooks | undefined`
  - union-members: `undefined`, `ScheduledTaskHooks`
- member: `uiPanel?`
  - since: 1.0.0
  - type: `UIPanel | undefined`
  - union-members: `undefined`, `UIPanel`

## export `ExtensionManifest`

- since: 1.0.0
- kind: type
- type: `ExtensionManifest`
- member: `anonymousRoutePaths?`
  - since: 3.23.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`
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
- member: `moduleDataRoutes?`
  - since: 3.10.0
  - type: `ModuleDataRouteDeclaration[] | undefined`
  - union-members: `undefined`, `ModuleDataRouteDeclaration[]`
- member: `name`
  - since: 1.0.0
  - type: `string`
- member: `navItems?`
  - since: 3.9.0
  - type: `ExtensionNavItem[] | undefined`
  - union-members: `undefined`, `ExtensionNavItem[]`
- member: `panelDataPaths?`
  - since: 3.8.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`
- member: `redirectOrigins?`
  - since: 3.16.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`
- member: `replacesNativeLogin?`
  - since: 1.0.0
  - type: `boolean | undefined`
  - union-members: `undefined`, `false`, `true`
- member: `scheduledTasks?`
  - since: 3.18.0
  - type: `ScheduledTaskDeclaration[] | undefined`
  - union-members: `undefined`, `ScheduledTaskDeclaration[]`
- member: `uiPanelSlots?`
  - since: 3.1.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`

## export `ExtensionNavItem`

- since: 3.9.0
- kind: type
- type: `ExtensionNavItem`
- member: `href`
  - since: 3.9.0
  - type: `string`
- member: `icon?`
  - since: 3.9.0
  - type: `"puzzle-piece" | "link" | "grid" | undefined`
  - union-members: `undefined`, `"puzzle-piece"`, `"link"`, `"grid"`
- member: `id`
  - since: 3.9.0
  - type: `string`
- member: `label`
  - since: 3.9.0
  - type: `string`
- member: `parentId?`
  - since: 3.9.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

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

## export `ExtensionRequestStateHostService`

- since: 3.19.0
- kind: type
- type: `ExtensionRequestStateHostService`
- member: `consume`
  - since: 3.19.0
  - type: `() => Promise<Record<string, unknown> | undefined>`
  - call-signature: `(): Promise<Record<string, unknown> | undefined>`

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
- member: `credentialSharing`
  - since: 3.22.0
  - type: `CredentialSharingHost`
  - member: `createExternalShare`
    - since: 3.22.0
    - type: `(params: CredentialSharingCreateExternalShareParams) => Promise<CredentialSharingCreateExternalShareResult>`
    - call-signature: `(params: CredentialSharingCreateExternalShareParams): Promise<CredentialSharingCreateExternalShareResult>`
  - member: `findShareByToken`
    - since: 3.22.0
    - type: `(rawToken: string) => Promise<CredentialSharingFindShareByTokenResult>`
    - call-signature: `(rawToken: string): Promise<CredentialSharingFindShareByTokenResult>`
  - member: `listSharesForCredential`
    - since: 3.23.0
    - type: `(params: CredentialSharingListParams) => Promise<CredentialSharingListResult>`
    - call-signature: `(params: CredentialSharingListParams): Promise<CredentialSharingListResult>`
  - member: `listSharesForOrganization`
    - since: 3.23.0
    - type: `(params: CredentialSharingOrgListParams) => Promise<CredentialSharingListResult>`
    - call-signature: `(params: CredentialSharingOrgListParams): Promise<CredentialSharingListResult>`
  - member: `revealShare`
    - since: 3.22.0
    - type: `(rawToken: string) => Promise<CredentialSharingRevealResult>`
    - call-signature: `(rawToken: string): Promise<CredentialSharingRevealResult>`
  - member: `revokeShare`
    - since: 3.22.0
    - type: `(params: CredentialSharingRevokeShareParams) => Promise<CredentialSharingRevokeShareResult>`
    - call-signature: `(params: CredentialSharingRevokeShareParams): Promise<CredentialSharingRevokeShareResult>`
  - member: `supersedeSharesForRotation`
    - since: 3.22.0
    - type: `(params: CredentialSharingSupersedeSharesForRotationParams) => Promise<CredentialSharingSupersedeSharesForRotationResult>`
    - call-signature: `(params: CredentialSharingSupersedeSharesForRotationParams): Promise<CredentialSharingSupersedeSharesForRotationResult>`
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
- member: `extensionRequestState`
  - since: 3.19.0
  - type: `ExtensionRequestStateHostService`
  - member: `consume`
    - since: 3.19.0
    - type: `() => Promise<Record<string, unknown> | undefined>`
    - call-signature: `(): Promise<Record<string, unknown> | undefined>`
- member: `monitoring`
  - since: 3.12.0
  - type: `PvMonitoringHost`
  - member: `applyHealthCheckResult`
    - since: 3.12.0
    - type: `(params: MonitoringApplyHealthCheckResultParams) => Promise<MonitoringApplyHealthCheckResultResult>`
    - call-signature: `(params: MonitoringApplyHealthCheckResultParams): Promise<MonitoringApplyHealthCheckResultResult>`
  - member: `cleanupProjectMonitoring`
    - since: 3.12.0
    - type: `(params: MonitoringCleanupProjectMonitoringParams) => Promise<MonitoringCleanupProjectMonitoringResult>`
    - call-signature: `(params: MonitoringCleanupProjectMonitoringParams): Promise<MonitoringCleanupProjectMonitoringResult>`
  - member: `createServiceEndpoint`
    - since: 3.17.0
    - type: `(params: MonitoringCreateServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord>`
    - call-signature: `(params: MonitoringCreateServiceEndpointParams): Promise<MonitoringServiceEndpointRecord>`
  - member: `deleteServiceEndpoint`
    - since: 3.12.0
    - type: `(params: MonitoringDeleteServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord | null>`
    - call-signature: `(params: MonitoringDeleteServiceEndpointParams): Promise<MonitoringServiceEndpointRecord | null>`
  - member: `disableStatusPage`
    - since: 3.12.0
    - type: `(params: MonitoringDisableStatusPageParams) => Promise<MonitoringDisableStatusPageResult | null>`
    - call-signature: `(params: MonitoringDisableStatusPageParams): Promise<MonitoringDisableStatusPageResult | null>`
  - member: `enableStatusPage`
    - since: 3.12.0
    - type: `(params: MonitoringEnableStatusPageParams) => Promise<MonitoringEnableStatusPageResult>`
    - call-signature: `(params: MonitoringEnableStatusPageParams): Promise<MonitoringEnableStatusPageResult>`
  - member: `getHealthDashboardData`
    - since: 3.12.0
    - type: `(params?: MonitoringGetHealthDashboardDataParams) => Promise<MonitoringHealthDashboard>`
    - call-signature: `(params?: MonitoringGetHealthDashboardDataParams): Promise<MonitoringHealthDashboard>`
  - member: `listServiceEndpointsForScheduling`
    - since: 3.20.0
    - type: `(params: MonitoringListServiceEndpointsForSchedulingParams) => Promise<MonitoringServiceEndpointForScheduling[]>`
    - call-signature: `(params: MonitoringListServiceEndpointsForSchedulingParams): Promise<MonitoringServiceEndpointForScheduling[]>`
  - member: `regenerateStatusPageToken`
    - since: 3.12.0
    - type: `(params: MonitoringRegenerateStatusPageTokenParams) => Promise<MonitoringRegenerateStatusPageTokenResult>`
    - call-signature: `(params: MonitoringRegenerateStatusPageTokenParams): Promise<MonitoringRegenerateStatusPageTokenResult>`
  - member: `updateServiceEndpointPauseState`
    - since: 3.12.0
    - type: `(params: MonitoringUpdateServiceEndpointPauseStateParams) => Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`
    - call-signature: `(params: MonitoringUpdateServiceEndpointPauseStateParams): Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`
- member: `notificationOriginator`
  - since: 3.14.0
  - type: `NotificationOriginatorHost`
  - member: `enqueueNotification`
    - since: 3.14.0
    - type: `(params: NotificationOriginatorEnqueueParams) => Promise<NotificationOriginatorEnqueueResult>`
    - call-signature: `(params: NotificationOriginatorEnqueueParams): Promise<NotificationOriginatorEnqueueResult>`
  - member: `enqueueNotificationForOrg`
    - since: 3.21.0
    - type: `(params: NotificationOriginatorEnqueueForOrgParams) => Promise<NotificationOriginatorEnqueueResult>`
    - call-signature: `(params: NotificationOriginatorEnqueueForOrgParams): Promise<NotificationOriginatorEnqueueResult>`
- member: `orgAuthorization`
  - since: 2.2.0
  - type: `OrgAuthorizationHost`
  - member: `checkMembership`
    - since: 2.2.0
    - type: `(context: OrgAuthorizationCheckContext) => Promise<OrgAuthorizationOutcome>`
    - call-signature: `(context: OrgAuthorizationCheckContext): Promise<OrgAuthorizationOutcome>`
- member: `projectAuthorization`
  - since: 3.15.0
  - type: `ProjectAuthorizationHost`
  - member: `checkProjectMembership`
    - since: 3.15.0
    - type: `(context: ProjectAuthorizationCheckContext) => Promise<ProjectAuthorizationOutcome>`
    - call-signature: `(context: ProjectAuthorizationCheckContext): Promise<ProjectAuthorizationOutcome>`

## export `isExtensionApiVersionSupported`

- since: 1.0.0
- kind: value
- type: `(declaredApiVersion: string) => boolean`
- call-signature: `(declaredApiVersion: string): boolean`

## export `MAX_ANONYMOUS_ROUTE_PATHS`

- since: 3.23.0
- kind: value
- type: `32`

## export `MAX_MODULE_ACTIONS`

- since: 3.3.0
- kind: value
- type: `32`

## export `MAX_MODULE_DATA_ROUTES`

- since: 3.10.0
- kind: value
- type: `32`

## export `MAX_NAV_ITEM_LABEL_LENGTH`

- since: 3.9.0
- kind: value
- type: `128`

## export `MAX_NAV_ITEMS`

- since: 3.9.0
- kind: value
- type: `32`

## export `MAX_PANEL_DATA_PATHS`

- since: 3.8.0
- kind: value
- type: `32`

## export `MAX_REDIRECT_ORIGINS`

- since: 3.16.0
- kind: value
- type: `32`

## export `MAX_SCHEDULED_TASKS_PER_EXTENSION`

- since: 3.18.0
- kind: value
- type: `32`

## export `MAX_UI_PANEL_SLOTS`

- since: 3.1.0
- kind: value
- type: `32`

## export `MIN_SCHEDULED_TASK_INTERVAL_MINUTES`

- since: 3.18.0
- kind: value
- type: `1`

## export `MODULE_ACTION_NAME_PATTERN`

- since: 3.3.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
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

## export `MODULE_DATA_ROUTE_PATH_PATTERN`

- since: 3.10.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.10.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.10.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.10.0
  - type: `string`
- member: `readonly global`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.10.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.10.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.10.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.10.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.10.0
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
- type: `ModuleActionContext`
- intersection-members: `UIPanelContext`, `{ requestState?: Record<string, unknown>; }`

## export `ModuleActionRequest`

- since: 3.3.0
- kind: type
- type: `ModuleActionRequest`
- member: `action`
  - since: 3.3.0
  - type: `Record<string, unknown> & { kind: string; }`
  - intersection-members: `Record<string, unknown>`, `{ kind: string; }`

## export `ModuleDataRequestContext`

- since: 3.10.0
- kind: type
- type: `ModuleDataRequestContext`
- member: `identity`
  - since: 3.10.0
  - type: `{ userId: string; orgRole: "owner" | "admin" | "member" | "viewer"; }`
  - member: `orgRole`
    - since: 3.10.0
    - type: `"owner" | "admin" | "member" | "viewer"`
    - union-members: `"owner"`, `"admin"`, `"member"`, `"viewer"`
  - member: `userId`
    - since: 3.10.0
    - type: `string`
- member: `orgId`
  - since: 3.10.0
  - type: `string`
- member: `params`
  - since: 3.10.0
  - type: `Record<string, string>`
  - index-signature: `[string]: string`
    - since: 3.10.0
- member: `query`
  - since: 3.10.0
  - type: `Record<string, string>`

## export `ModuleDataResult`

- since: 3.10.0
- kind: type
- type: `ModuleDataResult`
- member: `body`
  - since: 3.10.0
  - type: `unknown`
- member: `status?`
  - since: 3.10.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`

## export `ModuleDataRouteDeclaration`

- since: 3.10.0
- kind: type
- type: `ModuleDataRouteDeclaration`
- member: `method`
  - since: 3.10.0
  - type: `"GET"`
- member: `path`
  - since: 3.10.0
  - type: `string`

## export `ModuleDataRouteHandler`

- since: 3.10.0
- kind: type
- type: `ModuleDataRouteHandler`
- call-signature: `(context: ModuleDataRequestContext): Promise<ModuleDataResult>`

## export `MonitoringAlertType`

- since: 3.12.0
- kind: type
- type: `MonitoringAlertType`
- union-members: `"service.down"`, `"service.recovery"`

## export `MonitoringApplyHealthCheckResultParams`

- since: 3.12.0
- kind: type
- type: `MonitoringApplyHealthCheckResultParams`
- member: `checkedAt?`
  - since: 3.12.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `failureReason`
  - since: 3.12.0
  - type: `"timeout" | "http_error" | "network_error" | "ssrf_blocked" | null`
  - union-members: `null`, `"timeout"`, `"http_error"`, `"network_error"`, `"ssrf_blocked"`
- member: `isHealthy`
  - since: 3.12.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `latencyMs`
  - since: 3.12.0
  - type: `number`
- member: `organizationId`
  - since: 3.12.0
  - type: `string`
- member: `serviceEndpoint`
  - since: 3.12.0
  - type: `{ id: string; orgId: string; }`
  - member: `id`
    - since: 3.12.0
    - type: `string`
  - member: `orgId`
    - since: 3.12.0
    - type: `string`
- member: `statusCode`
  - since: 3.12.0
  - type: `number | null`
  - union-members: `null`, `number`

## export `MonitoringApplyHealthCheckResultResult`

- since: 3.12.0
- kind: type
- type: `MonitoringApplyHealthCheckResultResult`
- member: `alertFired`
  - since: 3.12.0
  - type: `MonitoringAlertType | null`
  - union-members: `null`, `"service.down"`, `"service.recovery"`
- member: `episodeKey`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `updatedRow`
  - since: 3.12.0
  - type: `MonitoringServiceEndpointRecord`
  - member: `checkFrequencyMinutes`
    - since: 3.12.0
    - type: `number`
  - member: `consecutiveFailures`
    - since: 3.12.0
    - type: `number`
  - member: `createdAt`
    - since: 3.12.0
    - type: `string`
  - member: `createdBy`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `downThresholdFailures`
    - since: 3.12.0
    - type: `number`
  - member: `healthCheckPaused`
    - since: 3.12.0
    - type: `boolean`
    - union-members: `false`, `true`
  - member: `healthCheckPausedAt`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `healthCheckPausedBy`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `id`
    - since: 3.12.0
    - type: `string`
  - member: `lastCheckedAt`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `name`
    - since: 3.12.0
    - type: `string`
  - member: `orgId`
    - since: 3.12.0
    - type: `string`
  - member: `projectId`
    - since: 3.12.0
    - type: `string`
  - member: `status`
    - since: 3.12.0
    - type: `MonitoringServiceEndpointStatus`
    - union-members: `"healthy"`, `"degraded"`, `"down"`
  - member: `updatedAt`
    - since: 3.12.0
    - type: `string`
  - member: `url`
    - since: 3.12.0
    - type: `string`

## export `MonitoringCleanupProjectMonitoringParams`

- since: 3.12.0
- kind: type
- type: `MonitoringCleanupProjectMonitoringParams`
- member: `organizationId`
  - since: 3.12.0
  - type: `string`
- member: `projectId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringCleanupProjectMonitoringResult`

- since: 3.12.0
- kind: type
- type: `MonitoringCleanupProjectMonitoringResult`
- member: `resolvedAlertCount`
  - since: 3.12.0
  - type: `number`

## export `MonitoringCreateServiceEndpointParams`

- since: 3.17.0
- kind: type
- type: `MonitoringCreateServiceEndpointParams`
- member: `checkFrequencyMinutes?`
  - since: 3.17.0
  - type: `5 | 1 | 15 | 30 | undefined`
  - union-members: `undefined`, `5`, `1`, `15`, `30`
- member: `downThresholdFailures?`
  - since: 3.17.0
  - type: `number | undefined`
  - union-members: `undefined`, `number`
- member: `name`
  - since: 3.17.0
  - type: `string`
- member: `projectId`
  - since: 3.17.0
  - type: `string`
- member: `url`
  - since: 3.17.0
  - type: `string`
- member: `userId`
  - since: 3.17.0
  - type: `string`

## export `MonitoringDeleteServiceEndpointParams`

- since: 3.12.0
- kind: type
- type: `MonitoringDeleteServiceEndpointParams`
- member: `projectId`
  - since: 3.12.0
  - type: `string`
- member: `serviceEndpointId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringDisableStatusPageParams`

- since: 3.12.0
- kind: type
- type: `MonitoringDisableStatusPageParams`
- member: `projectId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringDisableStatusPageResult`

- since: 3.12.0
- kind: type
- type: `MonitoringDisableStatusPageResult`
- member: `statusPageId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringEnableStatusPageParams`

- since: 3.12.0
- kind: type
- type: `MonitoringEnableStatusPageParams`
- member: `projectId`
  - since: 3.12.0
  - type: `string`
- member: `userId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringEnableStatusPageResult`

- since: 3.12.0
- kind: type
- type: `MonitoringEnableStatusPageResult`
- member: `createdAt`
  - since: 3.12.0
  - type: `string`
- member: `id`
  - since: 3.12.0
  - type: `string`
- member: `token`
  - since: 3.12.0
  - type: `string`

## export `MonitoringGetHealthDashboardDataParams`

- since: 3.12.0
- kind: type
- type: `MonitoringGetHealthDashboardDataParams`
- member: `permittedProjectIds?`
  - since: 3.12.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`

## export `MonitoringHealthDashboard`

- since: 3.12.0
- kind: type
- type: `MonitoringHealthDashboard`
- member: `projects`
  - since: 3.12.0
  - type: `MonitoringHealthDashboardProjectEntry[]`
- member: `summary`
  - since: 3.12.0
  - type: `MonitoringHealthDashboardSummary`
  - member: `degraded`
    - since: 3.12.0
    - type: `number`
  - member: `down`
    - since: 3.12.0
    - type: `number`
  - member: `healthy`
    - since: 3.12.0
    - type: `number`

## export `MonitoringHealthDashboardProjectEntry`

- since: 3.12.0
- kind: type
- type: `MonitoringHealthDashboardProjectEntry`
- member: `projectId`
  - since: 3.12.0
  - type: `string`
- member: `projectName`
  - since: 3.12.0
  - type: `string`
- member: `services`
  - since: 3.12.0
  - type: `MonitoringHealthDashboardServiceEntry[]`

## export `MonitoringHealthDashboardServiceEntry`

- since: 3.12.0
- kind: type
- type: `MonitoringHealthDashboardServiceEntry`
- member: `id`
  - since: 3.12.0
  - type: `string`
- member: `lastCheckedAt`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `status`
  - since: 3.12.0
  - type: `MonitoringServiceEndpointStatus`
  - union-members: `"healthy"`, `"degraded"`, `"down"`

## export `MonitoringHealthDashboardSummary`

- since: 3.12.0
- kind: type
- type: `MonitoringHealthDashboardSummary`
- member: `degraded`
  - since: 3.12.0
  - type: `number`
- member: `down`
  - since: 3.12.0
  - type: `number`
- member: `healthy`
  - since: 3.12.0
  - type: `number`

## export `MonitoringInvalidServiceEndpointInputError`

- since: 3.17.0
- kind: type
- type: `MonitoringInvalidServiceEndpointInputError`
- member: `cause?`
  - since: 3.17.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.17.0
  - type: `"monitoring_invalid_service_endpoint_input"`
- member: `readonly issues`
  - since: 3.17.0
  - type: `readonly { path: (string | number)[]; message: string; }[]`
- member: `message`
  - since: 3.17.0
  - type: `string`
- member: `name`
  - since: 3.17.0
  - type: `string`
- member: `stack?`
  - since: 3.17.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `MonitoringListServiceEndpointsForSchedulingParams`

- since: 3.20.0
- kind: type
- type: `MonitoringListServiceEndpointsForSchedulingParams`
- member: `organizationId`
  - since: 3.20.0
  - type: `string`

## export `MonitoringNoAmbientContextError`

- since: 3.12.0
- kind: type
- type: `MonitoringNoAmbientContextError`
- member: `cause?`
  - since: 3.12.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.12.0
  - type: `"monitoring_no_ambient_context"`
- member: `message`
  - since: 3.12.0
  - type: `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `stack?`
  - since: 3.12.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `MonitoringOrgMismatchError`

- since: 3.12.0
- kind: type
- type: `MonitoringOrgMismatchError`
- member: `cause?`
  - since: 3.12.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.12.0
  - type: `"monitoring_org_mismatch"`
- member: `message`
  - since: 3.12.0
  - type: `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `stack?`
  - since: 3.12.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `MonitoringRateLimitedError`

- since: 3.12.0
- kind: type
- type: `MonitoringRateLimitedError`
- member: `cause?`
  - since: 3.12.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.12.0
  - type: `"monitoring_rate_limited"`
- member: `message`
  - since: 3.12.0
  - type: `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `stack?`
  - since: 3.12.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `MonitoringRegenerateStatusPageTokenParams`

- since: 3.12.0
- kind: type
- type: `MonitoringRegenerateStatusPageTokenParams`
- member: `projectId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringRegenerateStatusPageTokenResult`

- since: 3.12.0
- kind: type
- type: `MonitoringRegenerateStatusPageTokenResult`
- member: `id`
  - since: 3.12.0
  - type: `string`
- member: `token`
  - since: 3.12.0
  - type: `string`
- member: `updatedAt`
  - since: 3.12.0
  - type: `string`

## export `MonitoringResourceNotFoundError`

- since: 3.12.0
- kind: type
- type: `MonitoringResourceNotFoundError`
- member: `cause?`
  - since: 3.12.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.12.0
  - type: `"monitoring_resource_not_found"`
- member: `message`
  - since: 3.12.0
  - type: `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `stack?`
  - since: 3.12.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `MonitoringServiceEndpointForScheduling`

- since: 3.20.0
- kind: type
- type: `MonitoringServiceEndpointForScheduling`
- member: `checkFrequencyMinutes`
  - since: 3.20.0
  - type: `number`
- member: `consecutiveFailures`
  - since: 3.20.0
  - type: `number`
- member: `healthCheckPausedAt`
  - since: 3.20.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `id`
  - since: 3.20.0
  - type: `string`
- member: `lastCheckedAt`
  - since: 3.20.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `name`
  - since: 3.20.0
  - type: `string`
- member: `orgId`
  - since: 3.20.0
  - type: `string`
- member: `projectId`
  - since: 3.20.0
  - type: `string`
- member: `status`
  - since: 3.20.0
  - type: `MonitoringServiceEndpointStatus`
  - union-members: `"healthy"`, `"degraded"`, `"down"`
- member: `url`
  - since: 3.20.0
  - type: `string`

## export `MonitoringServiceEndpointRecord`

- since: 3.12.0
- kind: type
- type: `MonitoringServiceEndpointRecord`
- member: `checkFrequencyMinutes`
  - since: 3.12.0
  - type: `number`
- member: `consecutiveFailures`
  - since: 3.12.0
  - type: `number`
- member: `createdAt`
  - since: 3.12.0
  - type: `string`
- member: `createdBy`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `downThresholdFailures`
  - since: 3.12.0
  - type: `number`
- member: `healthCheckPaused`
  - since: 3.12.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `healthCheckPausedAt`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `healthCheckPausedBy`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `id`
  - since: 3.12.0
  - type: `string`
- member: `lastCheckedAt`
  - since: 3.12.0
  - type: `string | null`
  - union-members: `null`, `string`
- member: `name`
  - since: 3.12.0
  - type: `string`
- member: `orgId`
  - since: 3.12.0
  - type: `string`
- member: `projectId`
  - since: 3.12.0
  - type: `string`
- member: `status`
  - since: 3.12.0
  - type: `MonitoringServiceEndpointStatus`
  - union-members: `"healthy"`, `"degraded"`, `"down"`
- member: `updatedAt`
  - since: 3.12.0
  - type: `string`
- member: `url`
  - since: 3.12.0
  - type: `string`

## export `MonitoringServiceEndpointStatus`

- since: 3.12.0
- kind: type
- type: `MonitoringServiceEndpointStatus`
- union-members: `"healthy"`, `"degraded"`, `"down"`

## export `MonitoringUpdateServiceEndpointPauseStateParams`

- since: 3.12.0
- kind: type
- type: `MonitoringUpdateServiceEndpointPauseStateParams`
- member: `paused`
  - since: 3.12.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `projectId`
  - since: 3.12.0
  - type: `string`
- member: `serviceEndpointId`
  - since: 3.12.0
  - type: `string`
- member: `userId`
  - since: 3.12.0
  - type: `string`

## export `MonitoringUpdateServiceEndpointPauseStateResult`

- since: 3.12.0
- kind: type
- type: `MonitoringUpdateServiceEndpointPauseStateResult`
- member: `pauseTransition`
  - since: 3.12.0
  - type: `"paused" | "resumed" | null`
  - union-members: `null`, `"paused"`, `"resumed"`
- member: `row`
  - since: 3.12.0
  - type: `MonitoringServiceEndpointRecord`
  - member: `checkFrequencyMinutes`
    - since: 3.12.0
    - type: `number`
  - member: `consecutiveFailures`
    - since: 3.12.0
    - type: `number`
  - member: `createdAt`
    - since: 3.12.0
    - type: `string`
  - member: `createdBy`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `downThresholdFailures`
    - since: 3.12.0
    - type: `number`
  - member: `healthCheckPaused`
    - since: 3.12.0
    - type: `boolean`
    - union-members: `false`, `true`
  - member: `healthCheckPausedAt`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `healthCheckPausedBy`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `id`
    - since: 3.12.0
    - type: `string`
  - member: `lastCheckedAt`
    - since: 3.12.0
    - type: `string | null`
    - union-members: `null`, `string`
  - member: `name`
    - since: 3.12.0
    - type: `string`
  - member: `orgId`
    - since: 3.12.0
    - type: `string`
  - member: `projectId`
    - since: 3.12.0
    - type: `string`
  - member: `status`
    - since: 3.12.0
    - type: `MonitoringServiceEndpointStatus`
    - union-members: `"healthy"`, `"degraded"`, `"down"`
  - member: `updatedAt`
    - since: 3.12.0
    - type: `string`
  - member: `url`
    - since: 3.12.0
    - type: `string`

## export `NAV_ITEM_HREF_PATTERN`

- since: 3.9.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.9.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.9.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.9.0
  - type: `string`
- member: `readonly global`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.9.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.9.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.9.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `NAV_ITEM_ICON_TOKENS`

- since: 3.9.0
- kind: value
- type: `readonly ["puzzle-piece", "link", "grid"]`

## export `NAV_ITEM_ID_PATTERN`

- since: 3.9.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.9.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.9.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.9.0
  - type: `string`
- member: `readonly global`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.9.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.9.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.9.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.9.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `NavItemIconToken`

- since: 3.9.0
- kind: type
- type: `"puzzle-piece" | "link" | "grid"`
- union-members: `"puzzle-piece"`, `"link"`, `"grid"`

## export `NotificationChannel`

- since: 1.0.0
- kind: type
- type: `NotificationChannel`
- member: `onNotify`
  - since: 1.0.0
  - type: `(payload: NotificationPayload) => Promise<void>`
  - call-signature: `(payload: NotificationPayload): Promise<void>`

## export `NotificationOriginatorChannel`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorChannel`
- union-members: `"email"`, `"inbox"`

## export `NotificationOriginatorEnqueueForOrgParams`

- since: 3.21.0
- kind: type
- type: `NotificationOriginatorEnqueueForOrgParams`
- intersection-members: `NotificationOriginatorEnqueueParams`, `{ organizationId: string; }`

## export `NotificationOriginatorEnqueueParams`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorEnqueueParams`
- member: `body`
  - since: 3.14.0
  - type: `string`
- member: `channel`
  - since: 3.14.0
  - type: `NotificationOriginatorChannel`
  - union-members: `"email"`, `"inbox"`
- member: `recipientEmail?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `recipientUserId?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`
- member: `subject`
  - since: 3.14.0
  - type: `string`

## export `NotificationOriginatorEnqueueResult`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorEnqueueResult`
- member: `notificationQueueId`
  - since: 3.14.0
  - type: `string`

## export `NotificationOriginatorHost`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorHost`
- member: `enqueueNotification`
  - since: 3.14.0
  - type: `(params: NotificationOriginatorEnqueueParams) => Promise<NotificationOriginatorEnqueueResult>`
  - call-signature: `(params: NotificationOriginatorEnqueueParams): Promise<NotificationOriginatorEnqueueResult>`
- member: `enqueueNotificationForOrg`
  - since: 3.21.0
  - type: `(params: NotificationOriginatorEnqueueForOrgParams) => Promise<NotificationOriginatorEnqueueResult>`
  - call-signature: `(params: NotificationOriginatorEnqueueForOrgParams): Promise<NotificationOriginatorEnqueueResult>`

## export `NotificationOriginatorInvalidParamsError`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorInvalidParamsError`
- member: `cause?`
  - since: 3.14.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.14.0
  - type: `"notification_originator_invalid_params"`
- member: `message`
  - since: 3.14.0
  - type: `string`
- member: `name`
  - since: 3.14.0
  - type: `string`
- member: `stack?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `NotificationOriginatorInvalidRecipientError`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorInvalidRecipientError`
- member: `cause?`
  - since: 3.14.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.14.0
  - type: `"notification_originator_invalid_recipient"`
- member: `message`
  - since: 3.14.0
  - type: `string`
- member: `name`
  - since: 3.14.0
  - type: `string`
- member: `stack?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `NotificationOriginatorNoAmbientContextError`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorNoAmbientContextError`
- member: `cause?`
  - since: 3.14.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.14.0
  - type: `"notification_originator_no_ambient_context"`
- member: `message`
  - since: 3.14.0
  - type: `string`
- member: `name`
  - since: 3.14.0
  - type: `string`
- member: `stack?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

## export `NotificationOriginatorRateLimitedError`

- since: 3.14.0
- kind: type
- type: `NotificationOriginatorRateLimitedError`
- member: `cause?`
  - since: 3.14.0
  - type: `unknown`
- member: `readonly code`
  - since: 3.14.0
  - type: `"notification_originator_rate_limited"`
- member: `message`
  - since: 3.14.0
  - type: `string`
- member: `name`
  - since: 3.14.0
  - type: `string`
- member: `stack?`
  - since: 3.14.0
  - type: `string | undefined`
  - union-members: `undefined`, `string`

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

## export `OAuthHandoffHooks`

- since: 3.16.0
- kind: type
- type: `OAuthHandoffHooks`
- member: `onOAuthCallback`
  - since: 3.16.0
  - type: `(query: Record<string, string>, state: Record<string, unknown>) => Promise<OAuthHandoffRedirectResult | ActionResult>`
  - call-signature: `(query: Record<string, string>, state: Record<string, unknown>): Promise<OAuthHandoffRedirectResult | ActionResult>`
- member: `onOAuthStart`
  - since: 3.16.0
  - type: `(context: ModuleActionContext, request: { action: Record<string, unknown> & { kind: string; }; }) => Promise<OAuthHandoffRedirectResult | ActionResult>`
  - call-signature: `(context: ModuleActionContext, request: { action: Record<string, unknown> & { kind: string; }; }): Promise<OAuthHandoffRedirectResult | ActionResult>`

## export `OAuthHandoffRedirectResult`

- since: 3.16.0
- kind: type
- type: `OAuthHandoffRedirectResult`
- member: `outcome`
  - since: 3.16.0
  - type: `"redirect"`
- member: `persistState?`
  - since: 3.19.0
  - type: `Record<string, unknown> | undefined`
  - union-members: `undefined`, `Record<string, unknown>`
- member: `state`
  - since: 3.16.0
  - type: `Record<string, unknown>`
  - index-signature: `[string]: unknown`
    - since: 3.16.0
- member: `url`
  - since: 3.16.0
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

## export `PANEL_DATA_PATH_PATTERN`

- since: 3.8.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.8.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.8.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.8.0
  - type: `string`
- member: `readonly global`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.8.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.8.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.8.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.8.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `ProjectArchivedContext`

- since: 3.13.0
- kind: type
- type: `ProjectArchivedContext`
- member: `archivedAt`
  - since: 3.13.0
  - type: `string`
- member: `archivedByUserId`
  - since: 3.13.0
  - type: `string`
- member: `organizationId`
  - since: 3.13.0
  - type: `string`
- member: `projectId`
  - since: 3.13.0
  - type: `string`

## export `ProjectArchiveNotifier`

- since: 3.13.0
- kind: type
- type: `ProjectArchiveNotifier`
- member: `onProjectArchived`
  - since: 3.13.0
  - type: `(context: ProjectArchivedContext) => Promise<void>`
  - call-signature: `(context: ProjectArchivedContext): Promise<void>`

## export `ProjectAuthorizationCheckContext`

- since: 3.15.0
- kind: type
- type: `ProjectAuthorizationCheckContext`
- member: `minimumRole`
  - since: 3.15.0
  - type: `"owner" | "admin" | "member" | "viewer"`
  - union-members: `"owner"`, `"admin"`, `"member"`, `"viewer"`
- member: `projectId`
  - since: 3.15.0
  - type: `string`
- member: `viewerIdentityId`
  - since: 3.15.0
  - type: `string`

## export `ProjectAuthorizationHost`

- since: 3.15.0
- kind: type
- type: `ProjectAuthorizationHost`
- member: `checkProjectMembership`
  - since: 3.15.0
  - type: `(context: ProjectAuthorizationCheckContext) => Promise<ProjectAuthorizationOutcome>`
  - call-signature: `(context: ProjectAuthorizationCheckContext): Promise<ProjectAuthorizationOutcome>`

## export `ProjectAuthorizationOutcome`

- since: 3.15.0
- kind: type
- type: `ProjectAuthorizationOutcome`
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

## export `PublicRouteHooks`

- since: 3.23.0
- kind: type
- type: `PublicRouteHooks`
- member: `onPublicRouteRequest`
  - since: 3.23.0
  - type: `(request: PublicRouteRequest) => Promise<PublicRouteResult | ActionResult>`
  - call-signature: `(request: PublicRouteRequest): Promise<PublicRouteResult | ActionResult>`

## export `PublicRouteRequest`

- since: 3.23.0
- kind: type
- type: `PublicRouteRequest`
- member: `method`
  - since: 3.23.0
  - type: `"GET"`
- member: `params`
  - since: 3.23.0
  - type: `Record<string, string>`
  - index-signature: `[string]: string`
    - since: 3.23.0
- member: `pathTemplate`
  - since: 3.23.0
  - type: `string`
- member: `query`
  - since: 3.23.0
  - type: `Record<string, string>`

## export `PublicRouteResult`

- since: 3.23.0
- kind: type
- type: `PublicRouteResult`
- member: `body?`
  - since: 3.23.0
  - type: `unknown`
- member: `headers?`
  - since: 3.23.0
  - type: `Record<string, string> | undefined`
  - union-members: `undefined`, `Record<string, string>`
- member: `outcome`
  - since: 3.23.0
  - type: `"response"`
- member: `status`
  - since: 3.23.0
  - type: `number`

## export `PvMonitoringHost`

- since: 3.12.0
- kind: type
- type: `PvMonitoringHost`
- member: `applyHealthCheckResult`
  - since: 3.12.0
  - type: `(params: MonitoringApplyHealthCheckResultParams) => Promise<MonitoringApplyHealthCheckResultResult>`
  - call-signature: `(params: MonitoringApplyHealthCheckResultParams): Promise<MonitoringApplyHealthCheckResultResult>`
- member: `cleanupProjectMonitoring`
  - since: 3.12.0
  - type: `(params: MonitoringCleanupProjectMonitoringParams) => Promise<MonitoringCleanupProjectMonitoringResult>`
  - call-signature: `(params: MonitoringCleanupProjectMonitoringParams): Promise<MonitoringCleanupProjectMonitoringResult>`
- member: `createServiceEndpoint`
  - since: 3.17.0
  - type: `(params: MonitoringCreateServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord>`
  - call-signature: `(params: MonitoringCreateServiceEndpointParams): Promise<MonitoringServiceEndpointRecord>`
- member: `deleteServiceEndpoint`
  - since: 3.12.0
  - type: `(params: MonitoringDeleteServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord | null>`
  - call-signature: `(params: MonitoringDeleteServiceEndpointParams): Promise<MonitoringServiceEndpointRecord | null>`
- member: `disableStatusPage`
  - since: 3.12.0
  - type: `(params: MonitoringDisableStatusPageParams) => Promise<MonitoringDisableStatusPageResult | null>`
  - call-signature: `(params: MonitoringDisableStatusPageParams): Promise<MonitoringDisableStatusPageResult | null>`
- member: `enableStatusPage`
  - since: 3.12.0
  - type: `(params: MonitoringEnableStatusPageParams) => Promise<MonitoringEnableStatusPageResult>`
  - call-signature: `(params: MonitoringEnableStatusPageParams): Promise<MonitoringEnableStatusPageResult>`
- member: `getHealthDashboardData`
  - since: 3.12.0
  - type: `(params?: MonitoringGetHealthDashboardDataParams) => Promise<MonitoringHealthDashboard>`
  - call-signature: `(params?: MonitoringGetHealthDashboardDataParams): Promise<MonitoringHealthDashboard>`
- member: `listServiceEndpointsForScheduling`
  - since: 3.20.0
  - type: `(params: MonitoringListServiceEndpointsForSchedulingParams) => Promise<MonitoringServiceEndpointForScheduling[]>`
  - call-signature: `(params: MonitoringListServiceEndpointsForSchedulingParams): Promise<MonitoringServiceEndpointForScheduling[]>`
- member: `regenerateStatusPageToken`
  - since: 3.12.0
  - type: `(params: MonitoringRegenerateStatusPageTokenParams) => Promise<MonitoringRegenerateStatusPageTokenResult>`
  - call-signature: `(params: MonitoringRegenerateStatusPageTokenParams): Promise<MonitoringRegenerateStatusPageTokenResult>`
- member: `updateServiceEndpointPauseState`
  - since: 3.12.0
  - type: `(params: MonitoringUpdateServiceEndpointPauseStateParams) => Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`
  - call-signature: `(params: MonitoringUpdateServiceEndpointPauseStateParams): Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`

## export `REDIRECT_ORIGIN_PATTERN`

- since: 3.16.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.16.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.16.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.16.0
  - type: `string`
- member: `readonly global`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.16.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.16.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.16.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.16.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `registerExtension`

- since: 1.0.0
- kind: value
- type: `(manifest: ExtensionManifest, hooksFactory: (context: ExtensionRuntimeContext & HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: ExtensionRuntimeContext & HostServices) => { manifest: ExtensionManifest; hooks: ExtensionHooks; }`
- call-signature: `(manifest: ExtensionManifest, hooksFactory: (context: ExtensionRuntimeContext & HostServices) => ExtensionHooks, options?: RegisterExtensionOptions, host?: ExtensionRuntimeContext & HostServices): { manifest: ExtensionManifest; hooks: ExtensionHooks; }`

## export `SCHEDULED_TASK_HANDLER_NAME`

- since: 3.18.0
- kind: value
- type: `"onScheduledTask"`

## export `SCHEDULED_TASK_NAME_PATTERN`

- since: 3.18.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
  - type: `(string: string, limit?: number) => string[]`
  - call-signature: `(string: string, limit?: number): string[]`
- member: `compile`
  - since: 3.18.0
  - type: `(pattern: string, flags?: string) => RegExp`
  - call-signature: `(pattern: string, flags?: string): RegExp`
- member: `readonly dotAll`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `exec`
  - since: 3.18.0
  - type: `(string: string) => RegExpExecArray | null`
  - call-signature: `(string: string): RegExpExecArray | null`
- member: `readonly flags`
  - since: 3.18.0
  - type: `string`
- member: `readonly global`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly hasIndices`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly ignoreCase`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `lastIndex`
  - since: 3.18.0
  - type: `number`
- member: `readonly multiline`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `readonly source`
  - since: 3.18.0
  - type: `string`
- member: `readonly sticky`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`
- member: `test`
  - since: 3.18.0
  - type: `(string: string) => boolean`
  - call-signature: `(string: string): boolean`
- member: `readonly unicode`
  - since: 3.18.0
  - type: `boolean`
  - union-members: `false`, `true`

## export `ScheduledTaskContext`

- since: 3.18.0
- kind: type
- type: `ScheduledTaskContext`
- member: `hostServices`
  - since: 3.18.0
  - type: `HostServices`
  - member: `auditEventSource`
    - since: 3.18.0
    - type: `AuditEventSourceHost`
    - member: `writeAuditEvent`
      - since: 3.18.0
      - type: `(input: AuditEventSourceWriteInput) => Promise<AuditEventSourceWriteResult>`
      - call-signature: `(input: AuditEventSourceWriteInput): Promise<AuditEventSourceWriteResult>`
  - member: `credentialSharing`
    - since: 3.22.0
    - type: `CredentialSharingHost`
    - member: `createExternalShare`
      - since: 3.22.0
      - type: `(params: CredentialSharingCreateExternalShareParams) => Promise<CredentialSharingCreateExternalShareResult>`
      - call-signature: `(params: CredentialSharingCreateExternalShareParams): Promise<CredentialSharingCreateExternalShareResult>`
    - member: `findShareByToken`
      - since: 3.22.0
      - type: `(rawToken: string) => Promise<CredentialSharingFindShareByTokenResult>`
      - call-signature: `(rawToken: string): Promise<CredentialSharingFindShareByTokenResult>`
    - member: `listSharesForCredential`
      - since: 3.23.0
      - type: `(params: CredentialSharingListParams) => Promise<CredentialSharingListResult>`
      - call-signature: `(params: CredentialSharingListParams): Promise<CredentialSharingListResult>`
    - member: `listSharesForOrganization`
      - since: 3.23.0
      - type: `(params: CredentialSharingOrgListParams) => Promise<CredentialSharingListResult>`
      - call-signature: `(params: CredentialSharingOrgListParams): Promise<CredentialSharingListResult>`
    - member: `revealShare`
      - since: 3.22.0
      - type: `(rawToken: string) => Promise<CredentialSharingRevealResult>`
      - call-signature: `(rawToken: string): Promise<CredentialSharingRevealResult>`
    - member: `revokeShare`
      - since: 3.22.0
      - type: `(params: CredentialSharingRevokeShareParams) => Promise<CredentialSharingRevokeShareResult>`
      - call-signature: `(params: CredentialSharingRevokeShareParams): Promise<CredentialSharingRevokeShareResult>`
    - member: `supersedeSharesForRotation`
      - since: 3.22.0
      - type: `(params: CredentialSharingSupersedeSharesForRotationParams) => Promise<CredentialSharingSupersedeSharesForRotationResult>`
      - call-signature: `(params: CredentialSharingSupersedeSharesForRotationParams): Promise<CredentialSharingSupersedeSharesForRotationResult>`
  - member: `ephemeralState`
    - since: 3.18.0
    - type: `EphemeralStateHost`
    - member: `compareAndDelete`
      - since: 3.18.0
      - type: `(key: string, expectedValue: string) => Promise<boolean>`
      - call-signature: `(key: string, expectedValue: string): Promise<boolean>`
    - member: `compareAndSwap`
      - since: 3.18.0
      - type: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number) => Promise<boolean>`
      - call-signature: `(key: string, expectedValue: string | null, newValue: string, ttlSeconds: number): Promise<boolean>`
    - member: `delete`
      - since: 3.18.0
      - type: `(key: string) => Promise<void>`
      - call-signature: `(key: string): Promise<void>`
    - member: `get`
      - since: 3.18.0
      - type: `(key: string) => Promise<string | undefined>`
      - call-signature: `(key: string): Promise<string | undefined>`
    - member: `set`
      - since: 3.18.0
      - type: `(key: string, value: string, ttlSeconds: number) => Promise<void>`
      - call-signature: `(key: string, value: string, ttlSeconds: number): Promise<void>`
  - member: `extensionRequestState`
    - since: 3.19.0
    - type: `ExtensionRequestStateHostService`
    - member: `consume`
      - since: 3.19.0
      - type: `() => Promise<Record<string, unknown> | undefined>`
      - call-signature: `(): Promise<Record<string, unknown> | undefined>`
  - member: `monitoring`
    - since: 3.18.0
    - type: `PvMonitoringHost`
    - member: `applyHealthCheckResult`
      - since: 3.18.0
      - type: `(params: MonitoringApplyHealthCheckResultParams) => Promise<MonitoringApplyHealthCheckResultResult>`
      - call-signature: `(params: MonitoringApplyHealthCheckResultParams): Promise<MonitoringApplyHealthCheckResultResult>`
    - member: `cleanupProjectMonitoring`
      - since: 3.18.0
      - type: `(params: MonitoringCleanupProjectMonitoringParams) => Promise<MonitoringCleanupProjectMonitoringResult>`
      - call-signature: `(params: MonitoringCleanupProjectMonitoringParams): Promise<MonitoringCleanupProjectMonitoringResult>`
    - member: `createServiceEndpoint`
      - since: 3.18.0
      - type: `(params: MonitoringCreateServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord>`
      - call-signature: `(params: MonitoringCreateServiceEndpointParams): Promise<MonitoringServiceEndpointRecord>`
    - member: `deleteServiceEndpoint`
      - since: 3.18.0
      - type: `(params: MonitoringDeleteServiceEndpointParams) => Promise<MonitoringServiceEndpointRecord | null>`
      - call-signature: `(params: MonitoringDeleteServiceEndpointParams): Promise<MonitoringServiceEndpointRecord | null>`
    - member: `disableStatusPage`
      - since: 3.18.0
      - type: `(params: MonitoringDisableStatusPageParams) => Promise<MonitoringDisableStatusPageResult | null>`
      - call-signature: `(params: MonitoringDisableStatusPageParams): Promise<MonitoringDisableStatusPageResult | null>`
    - member: `enableStatusPage`
      - since: 3.18.0
      - type: `(params: MonitoringEnableStatusPageParams) => Promise<MonitoringEnableStatusPageResult>`
      - call-signature: `(params: MonitoringEnableStatusPageParams): Promise<MonitoringEnableStatusPageResult>`
    - member: `getHealthDashboardData`
      - since: 3.18.0
      - type: `(params?: MonitoringGetHealthDashboardDataParams) => Promise<MonitoringHealthDashboard>`
      - call-signature: `(params?: MonitoringGetHealthDashboardDataParams): Promise<MonitoringHealthDashboard>`
    - member: `listServiceEndpointsForScheduling`
      - since: 3.20.0
      - type: `(params: MonitoringListServiceEndpointsForSchedulingParams) => Promise<MonitoringServiceEndpointForScheduling[]>`
      - call-signature: `(params: MonitoringListServiceEndpointsForSchedulingParams): Promise<MonitoringServiceEndpointForScheduling[]>`
    - member: `regenerateStatusPageToken`
      - since: 3.18.0
      - type: `(params: MonitoringRegenerateStatusPageTokenParams) => Promise<MonitoringRegenerateStatusPageTokenResult>`
      - call-signature: `(params: MonitoringRegenerateStatusPageTokenParams): Promise<MonitoringRegenerateStatusPageTokenResult>`
    - member: `updateServiceEndpointPauseState`
      - since: 3.18.0
      - type: `(params: MonitoringUpdateServiceEndpointPauseStateParams) => Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`
      - call-signature: `(params: MonitoringUpdateServiceEndpointPauseStateParams): Promise<MonitoringUpdateServiceEndpointPauseStateResult | null>`
  - member: `notificationOriginator`
    - since: 3.18.0
    - type: `NotificationOriginatorHost`
    - member: `enqueueNotification`
      - since: 3.18.0
      - type: `(params: NotificationOriginatorEnqueueParams) => Promise<NotificationOriginatorEnqueueResult>`
      - call-signature: `(params: NotificationOriginatorEnqueueParams): Promise<NotificationOriginatorEnqueueResult>`
    - member: `enqueueNotificationForOrg`
      - since: 3.21.0
      - type: `(params: NotificationOriginatorEnqueueForOrgParams) => Promise<NotificationOriginatorEnqueueResult>`
      - call-signature: `(params: NotificationOriginatorEnqueueForOrgParams): Promise<NotificationOriginatorEnqueueResult>`
  - member: `orgAuthorization`
    - since: 3.18.0
    - type: `OrgAuthorizationHost`
    - member: `checkMembership`
      - since: 3.18.0
      - type: `(context: OrgAuthorizationCheckContext) => Promise<OrgAuthorizationOutcome>`
      - call-signature: `(context: OrgAuthorizationCheckContext): Promise<OrgAuthorizationOutcome>`
  - member: `projectAuthorization`
    - since: 3.18.0
    - type: `ProjectAuthorizationHost`
    - member: `checkProjectMembership`
      - since: 3.18.0
      - type: `(context: ProjectAuthorizationCheckContext) => Promise<ProjectAuthorizationOutcome>`
      - call-signature: `(context: ProjectAuthorizationCheckContext): Promise<ProjectAuthorizationOutcome>`
- member: `organizationId`
  - since: 3.18.0
  - type: `string`
- member: `taskName`
  - since: 3.18.0
  - type: `string`

## export `ScheduledTaskDeclaration`

- since: 3.18.0
- kind: type
- type: `ScheduledTaskDeclaration`
- member: `handler`
  - since: 3.18.0
  - type: `"onScheduledTask"`
- member: `intervalMinutes`
  - since: 3.18.0
  - type: `number`
- member: `name`
  - since: 3.18.0
  - type: `string`

## export `ScheduledTaskHooks`

- since: 3.18.0
- kind: type
- type: `ScheduledTaskHooks`
- member: `onScheduledTask`
  - since: 3.18.0
  - type: `(context: ScheduledTaskContext) => Promise<void>`
  - call-signature: `(context: ScheduledTaskContext): Promise<void>`

## export `UI_PANEL_SLOT_NAME_PATTERN`

- since: 3.1.0
- kind: value
- type: `RegExp`
- member: `__@match@202`
  - since: 3.24.0
  - type: `(string: string) => RegExpMatchArray | null`
  - call-signature: `(string: string): RegExpMatchArray | null`
- member: `__@matchAll@211`
  - since: 3.24.0
  - type: `(str: string) => RegExpStringIterator<RegExpExecArray>`
  - call-signature: `(str: string): RegExpStringIterator<RegExpExecArray>`
- member: `__@replace@204`
  - since: 3.24.0
  - type: `{ (string: string, replaceValue: string): string; (string: string, replacer: (substring: string, ...args: any[]) => string): string; }`
  - call-signature: `(string: string, replaceValue: string): string`
  - call-signature: `(string: string, replacer: (substring: string, ...args: any[]) => string): string`
- member: `__@search@207`
  - since: 3.24.0
  - type: `(string: string) => number`
  - call-signature: `(string: string): number`
- member: `__@split@209`
  - since: 3.24.0
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
