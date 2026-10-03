// @project-vault/composition-kit: the MIT composer for Project Vault's web-host (ADR 0007).
export { defineUiPack } from './types.js'
export { defineGuardEntries } from './guard-entries.js'
export type {
  ExternalHrefInput,
  GuardEntriesInput,
  RouteClassificationInput,
  StorageEntryInput,
} from './guard-entries.js'
export type {
  CompatibilityTuple,
  HooksContribution,
  InjectionContribution,
  PvHooksModule,
  PvServerHooksModule,
  Replacement,
  RouteOverride,
  UiPackManifest,
} from './types.js'
export { compose } from './compose.js'
export type { ComposeResult, RunOptions } from './compose.js'
export { plan } from './plan.js'
export type { ComposeOptions, ComposePlan } from './plan.js'
export { cmAlias } from './alias.js'
export { loadManifest, validateManifest } from './manifest.js'
export type { CompositionLock } from './lock.js'
