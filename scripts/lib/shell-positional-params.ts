/**
 * Story 66-17: local reproduction of SonarCloud `shelldre:S7679` (positional parameters `$1`..`$9`
 * used directly inside a function body). ESLint cannot see shell, and the rule only surfaced after
 * push (66-20, 68-3, 68-4, 68-6, 68-9, 68-10, 68-15).
 *
 * The accepted form is the one the fix-pattern table prescribes: every positional parameter is
 * assigned to a variable (`local name="$1"`, `name=${2:-default}`) and only the variable is used.
 * Flagged: any other `$1` / `${1}` / `${10:-x}` occurrence inside a function body.
 *
 * A line scanner, not a shell parser. Known limits: a function is recognised by `name() {` /
 * `function name {` and ends where its own braces balance; heredoc bodies and multi-line strings
 * are scanned like code; quotes are only tracked within a single line. Single-quoted text and
 * trailing `# comments` are ignored (so `awk '{print $1}'` and `# $1 = file` pass).
 */
export type PositionalParamUse = { line: number; text: string }

// `function name`, `function name()` and `name()`; whatever follows is the rest of the line.
const FUNCTION_KEYWORD = /^\s*function\s+[\w:.-]+/
const FUNCTION_PARENS = /^\s*[\w:.-]+\s*\(\s*\)/
const EMPTY_PARENS = /^\s*\(\s*\)/
// Variable-declaration prefixes and their flags, dropped before looking for assignments.
const DECLARATION_PREFIX = /\b(?:local|readonly|declare)\s/g
const DECLARATION_FLAG = /\s-\w+(?=\s)/g
// `name="$1"`, `name=$2`, `name=${3:-x}`: the one permitted use of a positional parameter.
const ASSIGNMENT = /(?:^|\s)[A-Za-z_]\w*="?\$\{?\d+\S*/g
// `$0` (the script name) is not a positional parameter; `$1`..`$9` and `${10}`.. are.
const POSITIONAL = /\$(?:[1-9]|\{[1-9]\d*)/

/** The line without single-quoted spans and a trailing `# comment`. */
function codeOf(line: string): string {
  let out = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i)
    if (inSingle) {
      inSingle = ch !== "'"
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = true
      continue
    }
    if (ch === '"') inDouble = !inDouble
    const startsComment = ch === '#' && !inDouble && (i === 0 || /\s/.test(line.charAt(i - 1)))
    if (startsComment) break
    out += ch
  }
  return out
}

function braceDelta(code: string): number {
  let delta = 0
  for (const ch of code.replaceAll(/\$\{[^}]*\}/g, '')) {
    if (ch === '{') delta += 1
    else if (ch === '}') delta -= 1
  }
  return delta
}

function usesPositionalDirectly(code: string): boolean {
  return POSITIONAL.test(
    code
      .replaceAll(DECLARATION_PREFIX, '')
      .replaceAll(DECLARATION_FLAG, '')
      .replaceAll(ASSIGNMENT, ' ')
  )
}

type ScanState = { depth: number; awaitingBrace: boolean }

/** Advances the scanner over one line and says whether the line is function-body code. */
function step(code: string, state: ScanState): { body: string | null } {
  if (state.awaitingBrace) {
    if (!code.trim().startsWith('{')) {
      state.awaitingBrace = false
      return { body: null }
    }
    state.awaitingBrace = false
    state.depth = Math.max(braceDelta(code), 0)
    return { body: code.slice(code.indexOf('{') + 1) }
  }
  if (state.depth > 0) {
    state.depth = Math.max(state.depth + braceDelta(code), 0)
    return { body: code }
  }
  const start = FUNCTION_KEYWORD.exec(code) ?? FUNCTION_PARENS.exec(code)
  if (!start) return { body: null }
  const rest = code.slice(start[0].length).replace(EMPTY_PARENS, '').trimStart()
  if (!rest.includes('{')) {
    state.awaitingBrace = rest.trim() === ''
    return { body: null }
  }
  state.depth = Math.max(braceDelta(rest), 0)
  return { body: rest.slice(rest.indexOf('{') + 1) }
}

/** Every direct positional-parameter use inside a function body of `source`. */
export function findPositionalParamUses(source: string): PositionalParamUse[] {
  const findings: PositionalParamUse[] = []
  const state: ScanState = { depth: 0, awaitingBrace: false }
  source.split('\n').forEach((raw, index) => {
    const { body } = step(codeOf(raw), state)
    if (body !== null && usesPositionalDirectly(body)) {
      findings.push({ line: index + 1, text: raw.trim() })
    }
  })
  return findings
}
