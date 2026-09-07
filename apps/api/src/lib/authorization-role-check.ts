import type { OrgRole } from '../plugins/require-org-role.js'

// Shared by org-authorization.ts and project-authorization.ts: both hooks validate a caller-
// supplied `minimumRole` string against the same set of recognized org roles before ranking it.
// Extracted here (rather than duplicated per hook) purely to avoid literal duplication — this is
// NOT the per-extension in-flight rate-limiting budget, which stays intentionally separate and
// unshared between the two hooks (and capability-gate.ts) per each story's explicit instruction.
const RECOGNIZED_MINIMUM_ROLES = new Set<string>(['owner', 'admin', 'member', 'viewer'])

export function isRecognizedOrgRole(value: string): value is OrgRole {
  return RECOGNIZED_MINIMUM_ROLES.has(value)
}
