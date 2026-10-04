/**
 * Story 68.23: the proof that the runtime route audit runs in its SHIPPED form, the compiled entry
 * of the API image started with plain `node`, not the `tsx` form of `pnpm route-audit:runtime`.
 *
 * Pure data and checks (no Docker call here): `scripts/mock-ui-pack-e2e.ts` supplies the runner.
 * The cases sample the three documented exit codes; the parser and the classification rules are
 * 68-14 behaviour and are tested in `apps/api`, not re-tested here.
 */

/** The documented command, minus `docker run` flags: the path is pinned by a guard test. */
export const AUDIT_ENTRY = 'dist/scripts/runtime-route-audit.js'
/** Where the classification directory is mounted (read-only) inside the container. */
export const AUDIT_MOUNT = '/audit'
export const MOCK_PACK_PACKAGE = '@project-vault/mock-ui-pack'
const STALE_ROUTE = 'GET /cm/68-23-stale-classification'

/** Which classification file a case reads. */
export type ClassificationsInput = 'extracted' | 'stale' | 'none'

export interface AuditCase {
  name: string
  extension?: string
  classifications: ClassificationsInput
  /** Extra raw arguments, appended verbatim. */
  extraArgs?: readonly string[]
  exitCode: 0 | 1 | 2
  /** Text that must appear in stdout (exit 0/1) or stderr (exit 2/1 load failure). */
  mustContain: readonly string[]
}

export const AUDIT_CASES: readonly AuditCase[] = [
  {
    name: 'fully classified pack passes',
    extension: MOCK_PACK_PACKAGE,
    classifications: 'extracted',
    exitCode: 0,
    mustContain: ['route audit: PASS'],
  },
  {
    name: 'a stale classification fails and names its route',
    extension: MOCK_PACK_PACKAGE,
    classifications: 'stale',
    exitCode: 1,
    mustContain: ['route audit: FAIL', STALE_ROUTE],
  },
  {
    name: 'an unknown flag is a usage error',
    classifications: 'none',
    extraArgs: ['--no-such-flag', 'x'],
    exitCode: 2,
    mustContain: ['unknown argument "--no-such-flag"', 'usage: route-audit:runtime'],
  },
  {
    name: 'a path as the extension is a usage error',
    extension: './evil',
    classifications: 'none',
    exitCode: 2,
    mustContain: ['--extension must be a bare package specifier'],
  },
  {
    name: 'an unresolvable package fails to load',
    extension: '@project-vault/no-such-pack',
    classifications: 'none',
    exitCode: 1,
    mustContain: ['@project-vault/no-such-pack'],
  },
]

export function staleClassificationsText(): string {
  return `${JSON.stringify([{ route: STALE_ROUTE, reason: 'Story 68.23 proof: this route does not exist' }], null, 2)}\n`
}

/** The audit arguments of a case; classification files are named by their in-container path. */
export function auditArgs(auditCase: AuditCase, files: Record<'extracted' | 'stale', string>) {
  return [
    ...(auditCase.extension === undefined ? [] : ['--extension', auditCase.extension]),
    ...(auditCase.classifications === 'none'
      ? []
      : ['--classifications', `${AUDIT_MOUNT}/${files[auditCase.classifications]}`]),
    ...(auditCase.extraArgs ?? []),
  ]
}

/**
 * The `docker run` argv of the documented consumer invocation. `--network none` proves the audit
 * needs no database and no network; no env value is passed in.
 */
export function dockerRunArgs(image: string, auditDir: string, args: readonly string[]): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${auditDir}:${AUDIT_MOUNT}:ro`,
    image,
    'node',
    AUDIT_ENTRY,
    ...args,
  ]
}

export interface AuditRun {
  status: number | null
  stdout: string
  stderr: string
}

/** The problems of one run against its case (empty when the run is what the case documents). */
export function checkRun(auditCase: AuditCase, run: AuditRun): string[] {
  const problems: string[] = []
  if (run.status !== auditCase.exitCode) {
    problems.push(
      `${auditCase.name}: expected exit ${String(auditCase.exitCode)}, got ${String(run.status)}`
    )
  }
  const output = `${run.stdout}\n${run.stderr}`
  for (const text of auditCase.mustContain) {
    if (!output.includes(text)) problems.push(`${auditCase.name}: output lacks "${text}"`)
  }
  if (auditCase.exitCode === 2 && run.stdout.trim() !== '') {
    problems.push(`${auditCase.name}: a usage error must print nothing on stdout`)
  }
  return problems
}

/** Runs every case through `run` and returns all problems (empty = the shipped form is proven). */
export function proveShippedAudit(
  image: string,
  auditDir: string,
  files: Record<'extracted' | 'stale', string>,
  run: (argv: string[]) => AuditRun
): string[] {
  return AUDIT_CASES.flatMap((auditCase) =>
    checkRun(auditCase, run(dockerRunArgs(image, auditDir, auditArgs(auditCase, files))))
  )
}
