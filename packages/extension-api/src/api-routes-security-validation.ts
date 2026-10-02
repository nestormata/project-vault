import { ExtensionRegistrationError } from './errors.js'

/**
 * Story 68.8 AC-2 (a) — the shared integrity helpers of `apiRoutes` validation, and the check of
 * an entry's `security` object: known keys and well-formed values, exactly the shape
 * `ApiRouteSecurity` declares. A typo such as `minimumRol` would otherwise be dropped silently and
 * leave the route weaker than declared. Nothing here is a policy: every combination of valid
 * values is accepted.
 */

const INVALID = 'invalid-manifest-field'
const ORG_ROLES = ['owner', 'admin', 'member', 'viewer']
const ROLE_LIST = ORG_ROLES.join(', ')
const SECURITY_KEYS = [
  'requireAuth',
  'requireOrgScope',
  'minimumRole',
  'allowedRoles',
  'requireMfa',
  'requirePlatformOperator',
  'writeAuditEvent',
  'rateLimit',
  'capability',
]
const BOOLEAN_KEYS = ['requireAuth', 'requireOrgScope', 'requireMfa', 'requirePlatformOperator']
const RATE_LIMIT_KEYS = ['max', 'timeWindowMs', 'key']
const AUDIT_KEYS = ['eventType', 'resourceType', 'resourceIdFromParams']

export type UnknownRecord = Record<string, unknown>

/** Every apiRoutes integrity failure: the existing `invalid-manifest-field` reason (no new one). */
export function fail(message: string): never {
  throw new ExtensionRegistrationError(INVALID, message)
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldsOf(record: UnknownRecord): Map<string, unknown> {
  return new Map(Object.entries(record))
}

export function assertOnlyKeys(
  record: UnknownRecord,
  known: readonly string[],
  path: string
): void {
  const unknownKey = Object.keys(record).find((key) => !known.includes(key))
  if (unknownKey !== undefined) fail(`${path} has unknown key "${unknownKey}"`)
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0
}

function assertOptionalText(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    fail(`${path} must be a non-empty string`)
  }
}

function assertRole(value: unknown, path: string): void {
  if (typeof value !== 'string' || !ORG_ROLES.includes(value)) {
    fail(`${path} must be one of ${ROLE_LIST}`)
  }
}

function validateRoles(fields: Map<string, unknown>, path: string): void {
  const minimumRole = fields.get('minimumRole')
  if (minimumRole !== undefined) assertRole(minimumRole, `${path}.minimumRole`)
  const allowedRoles = fields.get('allowedRoles')
  if (allowedRoles === undefined) return
  if (!Array.isArray(allowedRoles)) fail(`${path}.allowedRoles must be an array`)
  allowedRoles.forEach((role, index) => assertRole(role, `${path}.allowedRoles[${index}]`))
}

function validateRateLimit(value: unknown, path: string): void {
  if (value === undefined || value === false) return
  if (!isRecord(value)) fail(`${path} must be false or an object`)
  assertOnlyKeys(value, RATE_LIMIT_KEYS, path)
  const fields = fieldsOf(value)
  if (!isPositiveInteger(fields.get('max'))) fail(`${path}.max must be a positive integer`)
  const timeWindowMs = fields.get('timeWindowMs')
  if (timeWindowMs !== undefined && !isPositiveInteger(timeWindowMs)) {
    fail(`${path}.timeWindowMs must be a positive integer`)
  }
  assertOptionalText(fields.get('key'), `${path}.key`)
}

function validateAudit(value: unknown, path: string): void {
  if (value === undefined || typeof value === 'boolean') return
  if (!isRecord(value)) fail(`${path} must be a boolean or an object`)
  assertOnlyKeys(value, AUDIT_KEYS, path)
  const fields = fieldsOf(value)
  if (fields.get('eventType') === undefined) fail(`${path}.eventType must be a non-empty string`)
  for (const key of AUDIT_KEYS) assertOptionalText(fields.get(key), `${path}.${key}`)
}

/** AC-2 (a): an entry's optional `security` object. */
export function validateApiRouteSecurity(value: unknown, path: string): void {
  if (value === undefined) return
  if (!isRecord(value)) fail(`${path} must be an object`)
  assertOnlyKeys(value, SECURITY_KEYS, path)
  const fields = fieldsOf(value)
  for (const key of BOOLEAN_KEYS) {
    const flag = fields.get(key)
    if (flag !== undefined && typeof flag !== 'boolean') fail(`${path}.${key} must be a boolean`)
  }
  validateRoles(fields, path)
  validateAudit(fields.get('writeAuditEvent'), `${path}.writeAuditEvent`)
  validateRateLimit(fields.get('rateLimit'), `${path}.rateLimit`)
  assertOptionalText(fields.get('capability'), `${path}.capability`)
}
