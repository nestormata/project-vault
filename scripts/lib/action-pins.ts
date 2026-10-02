// Story 64.2 AC-3: the third-party GitHub Actions SHA-pin rules, shared by
// scripts/check-action-pins.test.ts (every workflow) and Story 68.2's
// scripts/check-web-host-release-workflow.test.ts (the web-host release contract). Rules:
//   (a) a non-first-party (owner other than `actions`/`github`) ref must be `@<40-hex commit SHA>`;
//   (b) `@master`/`@main`/`@HEAD` is rejected for every owner, first-party included;
//   (c) a SHA pin must carry a trailing `# vX.Y.Z` / `# <tag>` comment.
// Local `./` actions and `docker://` refs are exempt.

const FIRST_PARTY_OWNERS = new Set(['actions', 'github'])
const BRANCH_REFS = new Set(['master', 'main', 'head'])
const FULL_SHA_RE = /^[0-9a-f]{40}$/
// A version-looking tag name after `#`: `v1`, `v4.6.0`, `1.6`, `v0.36.0`, `v2.0.0-rc.1`.
const VERSION_TAG_RE = /^v?\d[\w.+-]*$/

export interface UsesRef {
  file: string
  line: number
  ref: string
  comment: string | undefined
}

export interface PinViolation {
  file: string
  line: number
  ref: string
  reason: string
}

/** Parses one YAML line as a `uses:` key — a step key (`- uses:`) or a mapping key (`uses:`) —
 * returning its (optionally quoted) ref and trailing `#` comment, or undefined for any other line. */
function parseUsesLine(raw: string): { ref: string; comment: string | undefined } | undefined {
  let body = raw.trim()
  if (body.startsWith('- ')) body = body.slice(2).trim()
  if (!body.startsWith('uses:')) return undefined
  body = body.slice('uses:'.length).trim()

  const hashIndex = body.indexOf('#')
  const comment = hashIndex === -1 ? undefined : body.slice(hashIndex).trim()
  const value = (hashIndex === -1 ? body : body.slice(0, hashIndex)).trim()
  const ref = value.replaceAll(/^["']|["']$/g, '')
  return ref === '' ? undefined : { ref, comment }
}

/** Extracts every `uses:` ref (with its 1-based line number and trailing comment) from YAML text. */
export function parseUsesRefs(file: string, text: string): UsesRef[] {
  const refs: UsesRef[] = []
  text.split('\n').forEach((raw, index) => {
    const parsed = parseUsesLine(raw)
    if (parsed) refs.push({ file, line: index + 1, ...parsed })
  })
  return refs
}

function hasVersionComment(comment: string | undefined): boolean {
  return comment !== undefined && VERSION_TAG_RE.test(comment.slice(1).trim())
}

/** Applies rules (a)-(c) to one ref; returns the violation reason, or undefined when compliant. */
export function checkRef(usesRef: UsesRef): string | undefined {
  const { ref, comment } = usesRef
  if (ref.startsWith('./') || ref.startsWith('docker://')) return undefined

  const at = ref.lastIndexOf('@')
  if (at <= 0) return 'no `@<ref>` — a remote action must name an explicit ref'
  const owner = (ref.slice(0, at).split('/')[0] ?? '').toLowerCase()
  const version = ref.slice(at + 1)

  if (BRANCH_REFS.has(version.toLowerCase())) {
    return `\`@${version}\` is a mutable branch ref (rejected for every owner, first-party included)`
  }

  if (!FULL_SHA_RE.test(version)) {
    return FIRST_PARTY_OWNERS.has(owner)
      ? undefined
      : `third-party action \`@${version}\` is not a full 40-hex commit SHA`
  }
  return hasVersionComment(comment)
    ? undefined
    : 'SHA pin has no trailing `# vX.Y.Z` version comment'
}

export function findPinViolations(files: Record<string, string>): PinViolation[] {
  const violations: PinViolation[] = []
  for (const [file, text] of Object.entries(files)) {
    for (const usesRef of parseUsesRefs(file, text)) {
      const reason = checkRef(usesRef)
      if (reason) violations.push({ file, line: usesRef.line, ref: usesRef.ref, reason })
    }
  }
  return violations
}
