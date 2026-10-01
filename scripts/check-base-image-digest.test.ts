import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Story 64.1 / 64.6: base-image pin guard.
//
// Invariant: every byte of base-layer content entering a shipped image is named by an immutable
// `<image>@sha256:<64 hex>` digest that a reviewed PR changed. The guard
//   - DISCOVERS every Dockerfile in the repo (no hard-coded list a new image can fall outside of),
//   - requires every external `FROM` (and `COPY --from=` / `RUN --mount=...from=`) to be digest
//     pinned, `FROM scratch` and earlier stage names being the only exemptions,
//   - enforces lockstep PER IMAGE FAMILY (all `node@...` identical, all `postgres@...` identical),
//   - fails closed when discovery finds fewer files than the committed floor, when a Dockerfile
//     referenced by fly*.toml / docker-compose*.yml / workflows / scripts is not discovered, and
//     when a pinned image family has no entry in scripts/refresh-base-image.sh.
//
// Boundary: the guard cannot tell whether a digest exists or is recent. Freshness is the job of
// the image scan gates (Story 64.3) and the weekly refresh workflow (Story 64.4/64.6).
//
// Files are loaded at transform time with literal `import.meta.glob` patterns, never a
// non-literal readFileSync (security/detect-non-literal-fs-filename).

// Dockerfiles are discovered by name anywhere in the repo, minus dependencies, nested agent
// worktrees and BMAD artifacts. The filter below drops documentation named like a Dockerfile.
const DOCKERFILE_TEXT = new Map<string, string>(
  Object.entries(
    import.meta.glob<string>(
      [
        '../**/Dockerfile*',
        '../**/*.[Dd]ockerfile',
        '../**/[Cc]ontainerfile*',
        '!../**/node_modules/**',
        '!../.claude/**',
        '!../_bmad-output/**',
      ],
      { query: '?raw', import: 'default', eager: true }
    )
  )
)

// Files that name a Dockerfile to build. The closure check proves each named Dockerfile was
// discovered, so a non-conventionally named image cannot slip past name-based discovery.
const REFERRER_TEXT = Object.entries(
  import.meta.glob<string>(
    ['../fly*.toml', '../docker-compose*.yml', '../.github/workflows/*.yml', '../scripts/*.sh'],
    { query: '?raw', import: 'default', eager: true }
  )
)

const API_DOCKERFILE = 'apps/api/Dockerfile'
const WEB_DOCKERFILE = 'apps/web/Dockerfile'
const CI_DOCKERFILE = 'Dockerfile.ci'
const FLY_DB_DOCKERFILE = 'deploy/fly/db/Dockerfile'

/** Committed floor: removing or renaming a shipped image requires touching this list on purpose. */
const FLOOR_DOCKERFILES = [CI_DOCKERFILE, API_DOCKERFILE, WEB_DOCKERFILE, FLY_DB_DOCKERFILE]

/** Referenced values that are deliberately not Dockerfiles, with the reason. Empty: a referenced
 * non-Dockerfile fails closed until someone adds it here. */
const NON_DOCKERFILE_REFERENCES: ReadonlyMap<string, string> = new Map()

/** Image families the refresh script cannot rewrite, with the reason. Empty: a new family fails
 * the contract test until it is added to refresh-base-image.sh or listed here on purpose. */
const NOT_AUTO_REFRESHED: ReadonlyMap<string, string> = new Map()

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc'])

const ROOT = resolve(__dirname, '..')

function discoveredPaths(): string[] {
  return [...DOCKERFILE_TEXT.keys()]
    .map((key) => key.replace(/^\.\.\//, ''))
    .filter(isDockerfilePath)
    .sort((a, b) => a.localeCompare(b))
}

function dockerfileText(path: string): string {
  const text = DOCKERFILE_TEXT.get(`../${path}`)
  expect(text, `${path} must be loadable`).toBeDefined()
  return text ?? ''
}

/** True when the path's file name is a Dockerfile: `Dockerfile`, `Dockerfile.<suffix>` (not a
 * documentation extension), `<name>.dockerfile` or `Containerfile`, case-insensitively. */
export function isDockerfilePath(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (name === 'dockerfile' || name === 'containerfile') return true
  if (name.endsWith('.dockerfile') && name.length > '.dockerfile'.length) return true
  for (const prefix of ['dockerfile.', 'containerfile.']) {
    if (name.startsWith(prefix)) {
      const extension = name.slice(name.lastIndexOf('.') + 1)
      return !DOC_EXTENSIONS.has(extension)
    }
  }
  return false
}

/** Floor entries that discovery did not find. */
export function missingFromFloor(discovered: string[], floor: string[]): string[] {
  const found = new Set(discovered)
  return floor.filter((path) => !found.has(path))
}

/** Joins `\`-continued lines and drops comment-only lines (Docker ignores them, even inside a
 * continuation), returning one string per instruction. */
export function logicalLines(text: string): string[] {
  const lines: string[] = []
  let pending = ''
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('#')) continue
    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1)} `
      continue
    }
    const line = `${pending}${trimmed}`.trim()
    pending = ''
    if (line) lines.push(line)
  }
  if (pending.trim()) lines.push(pending.trim())
  return lines
}

type RefKind = 'stage' | 'scratch' | 'indirection' | 'external'

interface ParsedFrom {
  /** The image reference after `FROM` and any `--flag` options (before `AS <name>`). */
  ref: string
  kind: RefKind
  /** True when `ref` names an earlier stage declared with `AS <name>` in this same file. */
  isInternalStageRef: boolean
}

function classify(ref: string, declaredStages: Set<string>): RefKind {
  const lower = ref.toLowerCase()
  if (declaredStages.has(lower)) return 'stage'
  if (lower === 'scratch') return 'scratch'
  if (ref.includes('$')) return 'indirection'
  return 'external'
}

/** Parses one `FROM` instruction's tokens. Leading `--flag` options (`--platform=...`) are skipped
 * so the image ref, not the option, is classified; also reports the `AS <name>` stage it declares. */
function parseFromTokens(
  tokens: string[],
  declaredStages: Set<string>
): (ParsedFrom & { stageName?: string }) | undefined {
  let index = 1
  while (tokens.at(index)?.startsWith('--')) index += 1
  const ref = tokens.at(index)
  if (!ref) return undefined
  const kind = classify(ref, declaredStages)
  const stageName = tokens.at(index + 1)?.toUpperCase() === 'AS' ? tokens.at(index + 2) : undefined
  return { ref, kind, isInternalStageRef: kind === 'stage', stageName }
}

/** Parses every `FROM` instruction. A ref is a stage reference only when an EARLIER `AS <name>`
 * declared it, so a forward reference is treated as an external image. */
export function parseFromLines(dockerfileText: string): ParsedFrom[] {
  const declaredStages = new Set<string>()
  const parsed: ParsedFrom[] = []

  for (const line of logicalLines(dockerfileText)) {
    const tokens = line.split(/\s+/)
    if (tokens.at(0)?.toUpperCase() !== 'FROM') continue
    const from = parseFromTokens(tokens, declaredStages)
    if (!from) continue
    if (from.stageName) declaredStages.add(from.stageName.toLowerCase())
    parsed.push({ ref: from.ref, kind: from.kind, isInternalStageRef: from.isInternalStageRef })
  }

  return parsed
}

interface Pin {
  /** Image name without tag or digest, e.g. `node`, `postgres`, `ghcr.io/org/img`. */
  image: string
  /** Lowercase `sha256:<64 hex>`. */
  digest: string
}

/** Returns the image family and digest when `ref` is `<image>@sha256:<64 hex>` or
 * `<image>:<tag>@sha256:<64 hex>`, otherwise undefined. Plain string parsing, no backtracking
 * regex. */
export function pinOf(ref: string): Pin | undefined {
  const at = ref.indexOf('@')
  if (at === -1) return undefined
  const image = imageNameOf(ref.slice(0, at))
  const digest = ref.slice(at + 1)
  if (!image) return undefined
  return SHA256_DIGEST_RE.test(digest) ? { image, digest: digest.toLowerCase() } : undefined
}

/** `<image>` or `<image>:<tag>` (a registry `host:port/` prefix is not a tag) -> `<image>`;
 * undefined for an empty name, an empty tag, whitespace, `$` or a second `@`. */
function imageNameOf(named: string): string | undefined {
  if (named.length === 0 || named.includes('@') || /\s/.test(named) || named.includes('$')) {
    return undefined
  }
  const colon = named.lastIndexOf(':')
  if (colon <= named.lastIndexOf('/')) return named
  return colon === 0 || colon === named.length - 1 ? undefined : named.slice(0, colon)
}

interface InvalidRef {
  ref: string
  reason: string
}

interface DockerfileValidation {
  pins: Pin[]
  invalid: InvalidRef[]
  /** Convenience: the refs of `invalid`. */
  invalidRefs: string[]
}

function checkExternal(ref: string, pins: Pin[], invalid: InvalidRef[], context: string): void {
  const pin = pinOf(ref)
  if (pin) pins.push(pin)
  else invalid.push({ ref, reason: `${context} is not pinned as <image>@sha256:<64 hex>` })
}

/** `--from=<x>` of a COPY, or `from=<x>` inside a RUN `--mount=` option; undefined when absent. */
function copyOrMountSource(tokens: string[]): string | undefined {
  const instruction = tokens.at(0)?.toUpperCase()
  for (const token of tokens.slice(1)) {
    if (instruction === 'COPY' && token.startsWith('--from=')) return token.slice('--from='.length)
    if (instruction === 'RUN' && token.startsWith('--mount=')) {
      const part = token
        .slice('--mount='.length)
        .split(',')
        .find((option) => option.startsWith('from='))
      if (part) return part.slice('from='.length)
    }
  }
  return undefined
}

/** Validates one Dockerfile: every external `FROM`, `COPY --from=` and `RUN --mount from=` must be
 * digest-pinned; stage names (declared earlier), numeric stage indexes and `scratch` are exempt. */
export function validateDockerfile(dockerfileText: string): DockerfileValidation {
  const pins: Pin[] = []
  const invalid: InvalidRef[] = []
  const declaredStages = new Set<string>()

  for (const line of logicalLines(dockerfileText)) {
    const tokens = line.split(/\s+/)
    if (tokens.at(0)?.toUpperCase() === 'FROM') {
      const from = parseFromTokens(tokens, declaredStages)
      if (!from) continue
      if (from.kind === 'external') checkExternal(from.ref, pins, invalid, 'FROM')
      else if (from.kind === 'indirection') invalid.push({ ref: from.ref, reason: INDIRECTION })
      if (from.stageName) declaredStages.add(from.stageName.toLowerCase())
    } else {
      checkCopySource(tokens, declaredStages, pins, invalid)
    }
  }

  return { pins, invalid, invalidRefs: invalid.map((entry) => entry.ref) }
}

const INDIRECTION = 'FROM uses an ARG/variable indirection, so the base is unpinned'

/** Checks the `COPY --from=` / `RUN --mount=...from=` source of one instruction, if it has one. */
function checkCopySource(
  tokens: string[],
  declaredStages: Set<string>,
  pins: Pin[],
  invalid: InvalidRef[]
): void {
  const source = copyOrMountSource(tokens)
  if (source === undefined) return
  if (declaredStages.has(source.toLowerCase()) || /^\d+$/.test(source)) return
  checkExternal(source, pins, invalid, `${tokens.at(0)?.toUpperCase()} from=`)
}

interface AggregateValidation {
  invalid: { file: string; ref: string; reason: string }[]
  invalidRefs: string[]
  /** Per image family: digest -> files carrying it. */
  digestsByImage: Map<string, Map<string, string[]>>
  /** Families that pin more than one digest. */
  lockstepViolations: string[]
}

/** Validates a set of Dockerfiles together: every external base is a valid pin, and every family
 * (image name) pins exactly one digest across all files. */
export function validateAll(filesByPath: ReadonlyMap<string, string>): AggregateValidation {
  const invalid: AggregateValidation['invalid'] = []
  const digestsByImage: AggregateValidation['digestsByImage'] = new Map()

  for (const [file, text] of filesByPath) {
    const result = validateDockerfile(text)
    for (const entry of result.invalid) invalid.push({ file, ...entry })
    for (const { image, digest } of result.pins) {
      const family = digestsByImage.get(image) ?? new Map<string, string[]>()
      family.set(digest, [...(family.get(digest) ?? []), file])
      digestsByImage.set(image, family)
    }
  }

  const lockstepViolations = [...digestsByImage]
    .filter(([, digests]) => digests.size > 1)
    .map(([image]) => image)

  return {
    invalid,
    invalidRefs: invalid.map((entry) => entry.ref),
    digestsByImage,
    lockstepViolations,
  }
}

interface Reference {
  referrer: string
  path: string
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/** Dockerfile paths a referrer names: `dockerfile = "x"` (fly toml), `dockerfile: x` / `file: x` /
 * `DOCKERFILE: x` (compose, workflows) and `docker build ... -f x`. Values containing `$` (matrix
 * expressions) cannot be resolved statically and are skipped; every literal one is covered by the
 * same file's own matrix entries. */
export function extractReferences(referrer: string, text: string): Reference[] {
  const references: Reference[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^- /, '')
    if (line.startsWith('#')) continue
    const tokens = line.split(/\s+/)
    let value: string | undefined
    const keyed = /^(dockerfile|file|DOCKERFILE)\s*(:|=)\s*(\S.*)$/.exec(line)
    if (keyed) value = stripQuotes(keyed[3].trim())
    else if (line.includes('docker build') || line.includes('docker buildx build')) {
      const flag = tokens.indexOf('-f')
      value = flag === -1 ? undefined : tokens.at(flag + 1)
    }
    if (value && !value.includes('$')) references.push({ referrer, path: stripQuotes(value) })
  }
  return references
}

/** References whose path is neither discovered nor an explicitly allowed non-Dockerfile. */
export function unresolvedReferences(
  references: Reference[],
  discovered: string[],
  allowed: ReadonlyMap<string, string> = NON_DOCKERFILE_REFERENCES
): Reference[] {
  const found = new Set(discovered)
  return references.filter(({ path }) => !found.has(path) && !allowed.has(path))
}

/** Image families with neither a refresh-script entry nor a NOT_AUTO_REFRESHED reason. */
export function familiesMissingRefresh(
  families: string[],
  refreshImages: string[],
  notAutoRefreshed: ReadonlyMap<string, string> = NOT_AUTO_REFRESHED
): string[] {
  const covered = new Set([...refreshImages, ...notAutoRefreshed.keys()])
  return families.filter((family) => !covered.has(family))
}

const D = (char: string): string => `sha256:${char.repeat(64)}`
const FLOATING = 'postgres:16-alpine'
const files = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries))

describe('base image pin guard', () => {
  describe('parser fixtures', () => {
    it('T1: parses a bare postgres digest pin as external, valid, family postgres', () => {
      const [from] = parseFromLines(`FROM postgres@${D('a')} AS runner\n`)
      expect(from).toMatchObject({ ref: `postgres@${D('a')}`, kind: 'external' })
      expect(pinOf(from.ref)).toEqual({ image: 'postgres', digest: D('a') })
    })

    it('T2: skips leading --flag options so the image ref is classified, not the option', () => {
      const [from] = parseFromLines(`FROM --platform=$BUILDPLATFORM node@${D('a')} AS b\n`)
      expect(from.ref).toBe(`node@${D('a')}`)
      expect(validateDockerfile(`FROM --platform=linux/amd64 ${FLOATING}\n`).invalidRefs).toEqual([
        FLOATING,
      ])
    })

    it('T3: exempts the scratch keyword only', () => {
      expect(validateDockerfile('FROM scratch\nfrom SCRATCH\n').invalidRefs).toEqual([])
      expect(validateDockerfile('FROM scratchy\n').invalidRefs).toEqual(['scratchy'])
    })

    it('T4: fails ARG/variable indirection with an explicit reason', () => {
      const { invalid } = validateDockerfile('FROM $IMG\nFROM ${IMG}:tag\n')
      expect(invalid.map((entry) => entry.ref)).toEqual(['$IMG', '${IMG}:tag'])
      expect(invalid[0].reason).toContain('indirection')
    })

    it('T5: a forward stage reference is NOT exempt; an earlier one is, case-insensitively', () => {
      expect(
        validateDockerfile(`FROM builder AS x\nFROM node@${D('a')} AS builder\n`).invalidRefs
      ).toEqual(['builder'])
      expect(
        validateDockerfile(`FROM node@${D('a')} AS Builder\nFROM builder AS x\n`).invalidRefs
      ).toEqual([])
    })

    it('T13: reassembles a backslash-continued FROM and flags its floating ref', () => {
      expect(validateDockerfile(`FROM \\\n  ${FLOATING} AS runner\n`).invalidRefs).toEqual([
        FLOATING,
      ])
    })

    it('ignores comment lines and treats a lowercase from like FROM', () => {
      expect(validateDockerfile('# FROM alpine:3.20\n').invalidRefs).toEqual([])
      expect(validateDockerfile(`from ${FLOATING}\n`).invalidRefs).toEqual([FLOATING])
    })

    it('a late floating stage after pinned earlier stages still fails', () => {
      const text = `FROM node@${D('a')} AS b\nFROM node@${D('a')} AS c\nFROM alpine:3.20 AS late\n`
      expect(validateDockerfile(text).invalidRefs).toEqual(['alpine:3.20'])
    })

    it('T14: COPY --from / RUN --mount from= must be a stage, an index or a pinned ref', () => {
      const head = `FROM node@${D('a')} AS builder\n`
      expect(validateDockerfile(`${head}COPY --from=builder /a /b\n`).invalidRefs).toEqual([])
      expect(validateDockerfile(`${head}COPY --from=0 /a /b\n`).invalidRefs).toEqual([])
      expect(validateDockerfile(`${head}COPY --from=${FLOATING} /a /b\n`).invalidRefs).toEqual([
        FLOATING,
      ])
      expect(
        validateDockerfile(`${head}COPY --from=postgres@${D('b')} /a /b\n`).invalidRefs
      ).toEqual([])
      expect(
        validateDockerfile(`${head}RUN --mount=type=bind,from=alpine:3,target=/x true\n`)
          .invalidRefs
      ).toEqual(['alpine:3'])
    })

    it('T17: tag+digest and bare digest are the same family and digest, with ports in names', () => {
      expect(pinOf(`${FLOATING}@${D('c')}`)).toEqual({ image: 'postgres', digest: D('c') })
      expect(pinOf(`postgres@${D('c')}`)).toEqual({ image: 'postgres', digest: D('c') })
      expect(pinOf(`localhost:5000/team/img@${D('c')}`)).toEqual({
        image: 'localhost:5000/team/img',
        digest: D('c'),
      })
      expect(pinOf(`ghcr.io/org/img:1@${D('C')}`)?.digest).toBe(D('c'))
      expect(pinOf(FLOATING)).toBeUndefined()
      expect(pinOf(`postgres:@${D('c')}`)).toBeUndefined()
      expect(pinOf('postgres@sha256:short')).toBeUndefined()
    })
  })

  describe('lockstep per image family', () => {
    it('accepts one node digest everywhere and one postgres digest (T7)', () => {
      const result = validateAll(
        files({
          api: `FROM node@${D('a')} AS builder\nFROM node@${D('a')} AS runner\n`,
          web: `FROM node:24-alpine@${D('a')} AS builder\n`,
          db: `FROM postgres@${D('b')} AS runner\n`,
        })
      )
      expect(result.invalidRefs).toEqual([])
      expect(result.lockstepViolations).toEqual([])
      expect([...result.digestsByImage.keys()].sort()).toEqual(['node', 'postgres'])
    })

    it('fails when one node runner pins a different digest, naming both digests and files', () => {
      const result = validateAll(
        files({
          api: `FROM node@${D('c')} AS builder\n`,
          web: `FROM node@${D('d')} AS runner\n`,
        })
      )
      expect(result.lockstepViolations).toEqual(['node'])
      expect(Object.fromEntries(result.digestsByImage.get('node') ?? [])).toEqual({
        [D('c')]: ['api'],
        [D('d')]: ['web'],
      })
    })

    it('T6: two postgres digests violate only the postgres family', () => {
      const result = validateAll(
        files({
          a: `FROM node@${D('a')}\nFROM postgres@${D('b')}\n`,
          b: `FROM postgres@${D('c')}\n`,
        })
      )
      expect(result.lockstepViolations).toEqual(['postgres'])
    })

    it('the same digest under two image names is not a violation', () => {
      const result = validateAll(files({ a: `FROM node@${D('a')}\nFROM postgres@${D('a')}\n` }))
      expect(result.lockstepViolations).toEqual([])
    })

    it('fails on a floating tag-only FROM, naming the file', () => {
      const result = validateAll(files({ ci: 'FROM node:24-alpine\n' }))
      expect(result.invalid).toMatchObject([{ file: 'ci', ref: 'node:24-alpine' }])
    })

    it('exempts internal stage refs', () => {
      const result = validateAll(
        files({
          api:
            `FROM node@${D('e')} AS builder\n` +
            `FROM builder AS db-builder\n` +
            `FROM db-builder AS migrate\n`,
        })
      )
      expect(result.invalidRefs).toEqual([])
    })
  })

  describe('discovery', () => {
    it('T9: matches Dockerfile names but not documentation named like one', () => {
      for (const ok of [
        'Dockerfile',
        CI_DOCKERFILE,
        'Dockerfile.dev',
        API_DOCKERFILE,
        'infra/web.Dockerfile',
        'deploy/foo/Containerfile',
        'x/api.dockerfile',
      ]) {
        expect(isDockerfilePath(ok), ok).toBe(true)
      }
      for (const no of [
        'docs/Dockerfile.md',
        'apps/api/src/Dockerfile.md',
        'Dockerfile.txt',
        'DockerfileNotes',
        'apps/Dockerfile.d/readme',
        '.dockerfile',
      ]) {
        expect(isDockerfilePath(no), no).toBe(false)
      }
    })

    it('T8: the floor assertion fails when a shipped image is missing from discovery', () => {
      expect(missingFromFloor([CI_DOCKERFILE, API_DOCKERFILE], FLOOR_DOCKERFILES)).toEqual([
        WEB_DOCKERFILE,
        FLY_DB_DOCKERFILE,
      ])
      expect(
        missingFromFloor([...FLOOR_DOCKERFILES, 'services/foo/Dockerfile'], FLOOR_DOCKERFILES)
      ).toEqual([])
    })

    it('T15: a referenced Dockerfile outside the discovered set fails, naming referrer and path', () => {
      const references = [
        ...extractReferences('fly.web.toml', '  dockerfile = "apps/web/Dockerfile"\n'),
        ...extractReferences('fly.foo.toml', '  dockerfile = "infra/web.docker"\n'),
        ...extractReferences('ci.yml', '      - file: deploy/fly/db/Dockerfile\n'),
        ...extractReferences('s.sh', 'docker build -f deploy/foo/img --target runner .\n'),
        ...extractReferences('n.yml', '          DOCKERFILE: ${{ matrix.file }}\n'),
        ...extractReferences('c.yml', '#  file: ignored/Dockerfile\n  files: nope\n'),
        ...extractReferences('e.sh', 'COMPOSE=(-f docker-compose.yml -f docker-compose.e2e.yml)\n'),
      ]
      expect(unresolvedReferences(references, FLOOR_DOCKERFILES)).toEqual([
        { referrer: 'fly.foo.toml', path: 'infra/web.docker' },
        { referrer: 's.sh', path: 'deploy/foo/img' },
      ])
    })

    it('discovers a Dockerfile in any directory without editing the guard', () => {
      const text = 'FROM alpine:3.20\n'
      const result = validateAll(files({ 'services/foo/Dockerfile': text }))
      expect(result.invalid).toMatchObject([
        { file: 'services/foo/Dockerfile', ref: 'alpine:3.20' },
      ])
    })

    it('T16: a pinned family absent from the refresh table and NOT_AUTO_REFRESHED fails', () => {
      expect(
        familiesMissingRefresh(['node', 'postgres', 'alpine'], ['node', 'postgres'], new Map())
      ).toEqual(['alpine'])
      expect(
        familiesMissingRefresh(['alpine'], ['node'], new Map([['alpine', 'pinned by hand']]))
      ).toEqual([])
    })
  })

  describe('real files', () => {
    const paths = discoveredPaths()
    const filesByPath = new Map(paths.map((path) => [path, dockerfileText(path)]))

    it('discovers at least the committed floor of shipped Dockerfiles', () => {
      expect(missingFromFloor(paths, FLOOR_DOCKERFILES)).toEqual([])
    })

    it('does not scan dependencies, nested agent worktrees or documentation', () => {
      for (const path of paths) {
        expect(path, path).not.toMatch(/(^|\/)(node_modules|\.claude|_bmad-output)\//)
        expect(isDockerfilePath(path), path).toBe(true)
      }
    })

    it('pins every external base in every discovered Dockerfile by digest', () => {
      const { invalid } = validateAll(filesByPath)
      expect(invalid.map(({ file, ref, reason }) => `${file}: ${ref} (${reason})`)).toEqual([])
    })

    it('keeps each image family on exactly one digest across all files', () => {
      const { digestsByImage, lockstepViolations } = validateAll(filesByPath)
      expect(
        lockstepViolations.map(
          (image) => `${image}: ${JSON.stringify([...(digestsByImage.get(image) ?? [])])}`
        )
      ).toEqual([])
      expect([...digestsByImage.keys()]).toEqual(expect.arrayContaining(['node', 'postgres']))
    })

    it('finds the known external FROM counts per file', () => {
      const external = (path: string): number =>
        parseFromLines(dockerfileText(path)).filter((f) => f.kind === 'external').length
      // api: builder, runner and (Story 64.3) the minimal migrate image's own base.
      expect(external(API_DOCKERFILE)).toBe(3)
      expect(external(WEB_DOCKERFILE)).toBe(2)
      expect(external(CI_DOCKERFILE)).toBe(1)
      expect(external(FLY_DB_DOCKERFILE)).toBe(1)
    })

    it('every Dockerfile named by a toml/compose/workflow/script is in the discovered set', () => {
      const references = REFERRER_TEXT.flatMap(([key, text]) =>
        extractReferences(key.replace(/^\.\.\//, ''), text)
      )
      expect(references.length).toBeGreaterThanOrEqual(FLOOR_DOCKERFILES.length)
      expect(unresolvedReferences(references, paths)).toEqual([])
    })

    it('every pinned image family has a refresh-script entry or a NOT_AUTO_REFRESHED reason', () => {
      const result = spawnSync('bash', [resolve(ROOT, 'scripts/refresh-base-image.sh'), 'images'], {
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      const refreshImages = result.stdout.split('\n').filter(Boolean)
      const families = [...validateAll(filesByPath).digestsByImage.keys()]
      expect(familiesMissingRefresh(families, refreshImages)).toEqual([])
    })
  })
})
