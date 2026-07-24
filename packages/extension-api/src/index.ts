/**
 * AC1/AC2 — this is the ONLY import path extension authors use: `@project-vault/extension-api`.
 * Never `@project-vault/extension-api/hooks/...` — the package's `package.json#exports` map only
 * declares the root entry point (guarded by `index.test.ts`'s structural assertion and this
 * file's own review checklist item below).
 *
 * Review checklist for future changes to this file: adding a new hook type or manifest export
 * belongs here as a re-export from `src/hooks/*` or `src/*` — never add a corresponding
 * `hooks/*` subpath to this package's `exports` map in `package.json`.
 */
export type { AuthResult, AuthStrategy } from './hooks/auth-strategy.js'
export type { NotificationChannel, NotificationPayload } from './hooks/notification-channel.js'
export type { UIPanel, UIPanelContext, UIPanelResult } from './hooks/ui-panel.js'

export type { ExtensionCapability, ExtensionManifest } from './manifest.js'
export { EXTENSION_API_VERSION, defineExtension } from './manifest.js'

export type { ExtensionRegistrationErrorReason } from './errors.js'
export { ExtensionRegistrationError } from './errors.js'

export type { ExtensionHooks } from './register-extension.js'
export { isApiVersionCompatible, registerExtension } from './register-extension.js'
