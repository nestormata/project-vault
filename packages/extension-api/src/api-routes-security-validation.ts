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
  'delegation',
]
const BOOLEAN_KEYS = ['requireAuth', 'requireOrgScope', 'requireMfa', 'requirePlatformOperator']
const RATE_LIMIT_KEYS = ['max', 'timeWindowMs', 'key']
const AUDIT_KEYS = ['eventType', 'resourceType', 'resourceIdFromParams']
const DELEGATION_KEYS = ['subjectFields']
const SUBJECT_KEYS = ['org', 'actor']
const SUBJECT_FIELD_KEYS = ['in', 'name']
const SUBJECT_FIELD_LOCATIONS = ['body', 'params']
/** A plain identifier: the host indexes a parsed body or the params with it (Story 71.8). */
const SUBJECT_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const RESERVED_FIELD_NAMES = ['__proto__', 'constructor', 'prototype']

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

function validateSubjectField(value: unknown, path: string): string {
  if (!isRecord(value)) fail(`${path} must be an object`)
  assertOnlyKeys(value, SUBJECT_FIELD_KEYS, path)
  const fields = fieldsOf(value)
  const location = fields.get('in')
  if (typeof location !== 'string' || !SUBJECT_FIELD_LOCATIONS.includes(location)) {
    fail(`${path}.in must be one of ${SUBJECT_FIELD_LOCATIONS.join(', ')}`)
  }
  const name = fields.get('name')
  if (
    typeof name !== 'string' ||
    !SUBJECT_FIELD_NAME.test(name) ||
    RESERVED_FIELD_NAMES.includes(name)
  ) {
    fail(`${path}.name must be a plain identifier of at most 128 characters`)
  }
  return `${location}:${name}`
}

/** Story 71.8 AC-1: `security.delegation` is a boolean or a closed `{ subjectFields }` object. */
function validateDelegation(value: unknown, path: string): void {
  if (value === undefined || typeof value === 'boolean') return
  if (!isRecord(value)) fail(`${path} must be a boolean or an object`)
  assertOnlyKeys(value, DELEGATION_KEYS, path)
  const subjectFields = fieldsOf(value).get('subjectFields')
  if (subjectFields === undefined) return
  const subjectPath = `${path}.subjectFields`
  if (!isRecord(subjectFields)) fail(`${subjectPath} must be an object`)
  assertOnlyKeys(subjectFields, SUBJECT_KEYS, subjectPath)
  const fields = fieldsOf(subjectFields)
  const seen = SUBJECT_KEYS.flatMap((key) => {
    const field = fields.get(key)
    return field === undefined ? [] : [validateSubjectField(field, `${subjectPath}.${key}`)]
  })
  if (seen.length === 2 && seen[0] === seen[1]) {
    fail(`${subjectPath} org and actor must not name the same field`)
  }
}

/** Story 71.8 AC-2: a delegated route is authenticated by the assertion alone, no other way in. */
function assertDelegationConsistent(fields: Map<string, unknown>, path: string, routeKey: string) {
  const delegation = fields.get('delegation')
  if (delegation === undefined || delegation === false) return
  const contradictions: Array<[string, unknown, string]> = [
    ['requireAuth', false, 'a delegated route is authenticated by the assertion'],
    ['requireMfa', true, 'a service assertion is not proof of MFA'],
    ['requirePlatformOperator', true, 'a service assertion confers no operator status'],
  ]
  for (const [flag, bad, why] of contradictions) {
    if (fields.get(flag) === bad) {
      fail(`${path}: ${routeKey} declares delegation and cannot set ${flag}: ${bad} (${why})`)
    }
  }
}

/**
 * AC-2 (a): an entry's optional `security` object. `routeKey` (`"<METHOD> <url>"`) names the route
 * in the delegation contradiction messages.
 */
export function validateApiRouteSecurity(value: unknown, path: string, routeKey = path): void {
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
  validateDelegation(fields.get('delegation'), `${path}.delegation`)
  assertDelegationConsistent(fields, path, routeKey)
}
