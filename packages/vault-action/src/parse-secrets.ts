/**
 * Pure parser for the `secrets` action input (D2, AC-2 through AC-4). Makes zero network calls —
 * every validation here must run and pass before `src/index.ts` ever constructs an agent or
 * attempts a retrieval, so a workflow-authoring mistake never causes a partial retrieval.
 */

export type ParsedSecretEntry = {
  projectId: string
  credentialName: string
  envVarName: string
}

export type ParseSecretsSuccess = {
  ok: true
  /** Lowercase-normalized projectId shared by every entry — pass this to createVaultAgent(). */
  projectId: string
  entries: ParsedSecretEntry[]
}

export type ParseSecretsFailure = {
  ok: false
  error: string
}

export type ParseSecretsResult = ParseSecretsSuccess | ParseSecretsFailure

const SAFE_ENV_VAR_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

/** AC-3 — exact, case-insensitive reserved names. Prefixes (GITHUB_/ACTIONS_) checked separately. */
const RESERVED_ENV_VAR_NAMES = new Set(
  [
    'PATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'HOME',
    'SHELL',
    'GITHUB_TOKEN',
  ].map((name) => name.toUpperCase())
)

const RESERVED_ENV_VAR_PREFIXES = ['GITHUB_', 'ACTIONS_']

function isReservedEnvVarName(name: string): boolean {
  const upper = name.toUpperCase()
  if (RESERVED_ENV_VAR_NAMES.has(upper)) return true
  return RESERVED_ENV_VAR_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

function malformed(line: string): ParseSecretsFailure {
  return {
    ok: false,
    error: `Malformed 'secrets' line "${line}": expected 'PROJECT/CREDENTIAL_NAME as ENV_VAR_NAME'`,
  }
}

/**
 * Splits a single trimmed, non-blank line into a candidate entry, or returns null if the line
 * does not match the expected `PROJECT/NAME as ENV_VAR` shape at all (caller turns null into a
 * malformed-line failure).
 */
function splitLine(line: string): ParsedSecretEntry | null {
  // The LAST whitespace-delimited 'as' token in the line is the delimiter, so a PROJECT/NAME
  // segment that incidentally contains " as " is not mis-split — envVarName can't contain
  // whitespace, so it's always exactly the final token, and the delimiter is always exactly the
  // token immediately before it. Tokenizing on whitespace (rather than
  // /^(.+)\s+as\s+(\S+)$/) avoids Sonar's superlinear-backtracking flag (typescript:S8786) on
  // that pattern's unbounded `(.+)` ahead of a literal.
  const tokens = line.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length < 3) return null
  const envVarName = tokens[tokens.length - 1]
  if (tokens[tokens.length - 2] !== 'as') return null
  const mappingPart = tokens.slice(0, -2).join(' ')
  if (!mappingPart || !envVarName) return null

  const slashIndex = mappingPart.indexOf('/')
  if (slashIndex === -1) return null
  const projectId = mappingPart.slice(0, slashIndex).trim()
  const credentialName = mappingPart.slice(slashIndex + 1).trim()
  if (!projectId || !credentialName) return null

  return { projectId, credentialName, envVarName }
}

/** AC-3 — validates a single already-structurally-parsed entry's envVarName. Returns null when valid. */
function validateEnvVarName(envVarName: string): ParseSecretsFailure | null {
  if (!SAFE_ENV_VAR_REGEX.test(envVarName)) {
    return {
      ok: false,
      error: `Invalid environment variable target '${envVarName}': must match ^[A-Za-z_][A-Za-z0-9_]*$`,
    }
  }
  if (isReservedEnvVarName(envVarName)) {
    return {
      ok: false,
      error: `Refusing to export to reserved/dangerous environment variable '${envVarName}' — this could hijack a later step's execution environment`,
    }
  }
  return null
}

/** AC-3 edge case — case-insensitive duplicate ENV_VAR_NAME detection across all parsed entries. */
function findDuplicateEnvVar(entries: ParsedSecretEntry[]): ParseSecretsFailure | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.envVarName.toUpperCase()
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate environment variable target: ${entry.envVarName}` }
    }
    seen.add(key)
  }
  return null
}

/** D2/AC-4 — case-insensitive (lowercase-normalized) cross-project validation. */
function findCrossProjectMismatch(entries: ParsedSecretEntry[]): ParseSecretsFailure | null {
  const distinctProjectIds: string[] = []
  const seenProjectIds = new Set<string>()
  for (const entry of entries) {
    const normalized = entry.projectId.toLowerCase()
    if (!seenProjectIds.has(normalized)) {
      seenProjectIds.add(normalized)
      distinctProjectIds.push(entry.projectId)
    }
  }
  if (distinctProjectIds.length <= 1) return null
  return {
    ok: false,
    error: `All 'secrets' entries must reference the same project (found: ${distinctProjectIds.join(', ')}). One vault-action step retrieves secrets from exactly one project — split into multiple steps, each with that project's own api-key, to pull from multiple projects.`,
  }
}

function parseLines(lines: string[]): ParsedSecretEntry[] | ParseSecretsFailure {
  const entries: ParsedSecretEntry[] = []
  for (const line of lines) {
    const entry = splitLine(line)
    if (!entry) return malformed(line)

    const invalid = validateEnvVarName(entry.envVarName)
    if (invalid) return invalid

    entries.push(entry)
  }
  return entries
}

export function parseSecrets(rawInput: string): ParseSecretsResult {
  const lines = rawInput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return {
      ok: false,
      error: "The 'secrets' input must contain at least one PROJECT/NAME as ENV_VAR mapping",
    }
  }

  const parsed = parseLines(lines)
  if (!Array.isArray(parsed)) return parsed
  const entries = parsed

  const duplicateFailure = findDuplicateEnvVar(entries)
  if (duplicateFailure) return duplicateFailure

  const crossProjectFailure = findCrossProjectMismatch(entries)
  if (crossProjectFailure) return crossProjectFailure

  return {
    ok: true,
    projectId: (entries[0]?.projectId ?? '').toLowerCase(),
    entries,
  }
}
