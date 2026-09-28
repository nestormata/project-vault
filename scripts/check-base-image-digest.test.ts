import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 64.1 AC-2: the node:24-alpine base digest appears in five `FROM` lines across three
// files (apps/api/Dockerfile builder+runner, apps/web/Dockerfile builder+runner, Dockerfile.ci).
// A partial digest bump is the easiest way to regress — this guard parses every `FROM` line in
// those three files and asserts every external (non-stage) base is pinned to the same
// `node@sha256:<64 hex>` (or `node:<tag>@sha256:<64 hex>`) reference.

const DOCKERFILE_PATHS = ['apps/api/Dockerfile', 'apps/web/Dockerfile', 'Dockerfile.ci']

const FROM_LINE_RE = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim

// Matches `node@sha256:<64hex>` or `node:<tag>@sha256:<64hex>`.
const VALID_NODE_DIGEST_RE = /^node(?::[^@\s]+)?@sha256:[0-9a-f]{64}$/i

interface ParsedFrom {
  /** The raw reference after `FROM ` (before any `AS <name>`). */
  ref: string
  /** True when `ref` names an earlier stage declared with `AS <name>` in this same file. */
  isInternalStageRef: boolean
}

/**
 * Parses every `FROM` line in a Dockerfile's text. A `FROM` line's reference is classified as an
 * internal stage reference (and exempted from the external-base rules) when it exactly matches
 * the name of a stage declared earlier via `AS <name>` in the same file — e.g.
 * `FROM builder AS db-builder` after an earlier `FROM node@sha256:... AS builder`.
 */
export function parseFromLines(dockerfileText: string): ParsedFrom[] {
  const declaredStageNames = new Set<string>()
  const matches = [...dockerfileText.matchAll(FROM_LINE_RE)]

  const parsed: ParsedFrom[] = matches.map((match) => {
    const ref = match[1]
    const isInternalStageRef = declaredStageNames.has(ref.toLowerCase())
    const stageName = match[2]
    if (stageName) declaredStageNames.add(stageName.toLowerCase())
    return { ref, isInternalStageRef }
  })

  return parsed
}

interface DockerfileValidation {
  /** Externally-pinned node base digests found in this file (lowercase `sha256:<hex>` values). */
  digests: string[]
  /** External `FROM` refs that are not a valid `node@sha256:...`/`node:<tag>@sha256:...` pin. */
  invalidRefs: string[]
}

/** Validates a single Dockerfile's external base references against AC-2(a). */
export function validateDockerfile(dockerfileText: string): DockerfileValidation {
  const digests: string[] = []
  const invalidRefs: string[] = []

  for (const { ref, isInternalStageRef } of parseFromLines(dockerfileText)) {
    if (isInternalStageRef) continue

    if (!VALID_NODE_DIGEST_RE.test(ref)) {
      invalidRefs.push(ref)
      continue
    }

    const digestMatch = ref.match(/sha256:[0-9a-f]{64}$/i)
    digests.push((digestMatch?.[0] ?? '').toLowerCase())
  }

  return { digests, invalidRefs }
}

/** Validates a set of Dockerfiles together against AC-2(a)+(b): every external base must be a
 * valid pin, and every valid digest found across all files must be identical. */
function validateAll(filesByPath: Record<string, string>): {
  invalidRefs: string[]
  uniqueDigests: string[]
} {
  const allDigests: string[] = []
  const allInvalidRefs: string[] = []

  for (const text of Object.values(filesByPath)) {
    const { digests, invalidRefs } = validateDockerfile(text)
    allDigests.push(...digests)
    allInvalidRefs.push(...invalidRefs)
  }

  return { invalidRefs: allInvalidRefs, uniqueDigests: [...new Set(allDigests)] }
}

describe('base image digest lockstep guard', () => {
  describe('parser fixtures (RED proof — fail until the parser/validator exists)', () => {
    it('accepts a bare-digest pin repeated consistently across files', () => {
      const digest = 'sha256:' + 'a'.repeat(64)
      const { invalidRefs, uniqueDigests } = validateAll({
        a: `FROM node@${digest} AS builder\nFROM node@${digest} AS runner\n`,
        b: `FROM node@${digest} AS builder\n`,
      })

      expect(invalidRefs).toEqual([])
      expect(uniqueDigests).toEqual([digest])
    })

    it('accepts the tag+digest pin form, and treats it as equal to the same bare digest', () => {
      const digest = 'sha256:' + 'b'.repeat(64)
      const { invalidRefs, uniqueDigests } = validateAll({
        a: `FROM node:24-alpine@${digest} AS builder\n`,
        b: `FROM node@${digest} AS runner\n`,
      })

      expect(invalidRefs).toEqual([])
      expect(uniqueDigests).toEqual([digest])
    })

    it('fails when one runner stage pins a different digest than the rest (mixed digests)', () => {
      const digestA = 'sha256:' + 'c'.repeat(64)
      const digestB = 'sha256:' + 'd'.repeat(64)
      const { invalidRefs, uniqueDigests } = validateAll({
        api: `FROM node@${digestA} AS builder\nFROM node@${digestA} AS runner\n`,
        web: `FROM node@${digestA} AS builder\nFROM node@${digestB} AS runner\n`,
      })

      expect(invalidRefs).toEqual([])
      expect(uniqueDigests.length).toBeGreaterThan(1)
    })

    it('fails on a floating tag-only FROM with no digest', () => {
      const { invalidRefs } = validateAll({
        ci: 'FROM node:24-alpine\n',
      })

      expect(invalidRefs).toEqual(['node:24-alpine'])
    })

    it('exempts internal stage refs (FROM builder AS ..., FROM db-builder AS ...)', () => {
      const digest = 'sha256:' + 'e'.repeat(64)
      const { invalidRefs, uniqueDigests } = validateAll({
        api:
          `FROM node@${digest} AS builder\n` +
          `FROM builder AS db-builder\n` +
          `FROM db-builder AS app-builder\n` +
          `FROM node@${digest} AS runner\n` +
          `FROM db-builder AS migrate\n`,
      })

      expect(invalidRefs).toEqual([])
      expect(uniqueDigests).toEqual([digest])
    })
  })

  describe('real files', () => {
    const repositoryRoot = resolve(__dirname, '..')

    it('pins every external base in apps/api/Dockerfile, apps/web/Dockerfile and Dockerfile.ci to one identical, validly-formed node digest', () => {
      const filesByPath = Object.fromEntries(
        DOCKERFILE_PATHS.map((path) => [path, readFileSync(resolve(repositoryRoot, path), 'utf8')])
      )

      const { invalidRefs, uniqueDigests } = validateAll(filesByPath)

      expect(invalidRefs).toEqual([])
      expect(uniqueDigests).toHaveLength(1)
      expect(uniqueDigests[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it('finds exactly three external FROM lines in apps/api/Dockerfile, two in apps/web/Dockerfile, and one in Dockerfile.ci', () => {
      const apiFrom = parseFromLines(
        readFileSync(resolve(repositoryRoot, 'apps/api/Dockerfile'), 'utf8')
      ).filter((f) => !f.isInternalStageRef)
      const webFrom = parseFromLines(
        readFileSync(resolve(repositoryRoot, 'apps/web/Dockerfile'), 'utf8')
      ).filter((f) => !f.isInternalStageRef)
      const ciFrom = parseFromLines(
        readFileSync(resolve(repositoryRoot, 'Dockerfile.ci'), 'utf8')
      ).filter((f) => !f.isInternalStageRef)

      // api: builder, runner, and (Story 64.3) the minimal migrate image's own fresh base.
      expect(apiFrom).toHaveLength(3)
      expect(webFrom).toHaveLength(2)
      expect(ciFrom).toHaveLength(1)
    })
  })
})
