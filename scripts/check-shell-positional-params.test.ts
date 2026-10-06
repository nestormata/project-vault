import { describe, expect, it } from 'vitest'
import { checkShellFiles, main, RULE_KEY } from './check-shell-positional-params.js'
import { findPositionalParamUses } from './lib/shell-positional-params.js'
import { runScriptCli, useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const SCRIPT = 'scripts/check-shell-positional-params.ts'
const makeFixtureRoot = useFixtureRoots('shell-positional-params-', [])

const uses = (source: string) => findPositionalParamUses(source).map((use) => use.line)

describe('findPositionalParamUses (shelldre:S7679)', () => {
  it('flags a positional parameter used directly in a function body', () => {
    expect(uses('greet() {\n  echo "hello $1"\n}\n')).toEqual([2])
  })

  it('accepts the prescribed form: every positional assigned to a local first', () => {
    const source = [
      'greet() {',
      '  local name="$1"',
      '  local greeting=${2:-hello}',
      '  readonly shout="${3}"',
      '  echo "$greeting $name"',
      '}',
    ].join('\n')
    expect(uses(source)).toEqual([])
  })

  it('still flags a later direct use when the first use is a local assignment', () => {
    const source = ['f() {', '  local a="$1"', '  echo "$a $2"', '}'].join('\n')
    expect(uses(source)).toEqual([3])
  })

  it('flags ${10} style and defaulted expansions used directly', () => {
    expect(uses('f() {\n  echo "${10}"\n  echo "${1:-x}"\n}')).toEqual([2, 3])
  })

  it('ignores $1 outside any function (script-level arguments)', () => {
    expect(uses('target="$1"\necho "$2"\nf() {\n  :\n}\necho "$1"\n')).toEqual([])
  })

  it('handles the `function name {` form and a brace on the next line', () => {
    expect(uses('function f {\n  echo "$1"\n}\n')).toEqual([2])
    expect(uses('f()\n{\n  echo "$1"\n}\n')).toEqual([3])
  })

  it('checks a one-line function body', () => {
    expect(uses('f() { echo "$1"; }\n')).toEqual([1])
    expect(uses('f() { local a="$1"; echo "$a"; }\n')).toEqual([])
  })

  it('ignores single-quoted text and trailing comments', () => {
    const source = [
      'f() {',
      "  awk '{print $1}' file",
      '  # $1 = target file',
      '  echo done # prints $2',
      '}',
    ].join('\n')
    expect(uses(source)).toEqual([])
  })

  it('ends a function where its braces balance, including nested blocks and ${var} expansions', () => {
    const source = [
      'f() {',
      '  local value="${VAR:-x}"',
      '  if [ -n "$value" ]; then',
      '    { echo a; }',
      '  fi',
      '}',
      'echo "$1"',
    ].join('\n')
    expect(uses(source)).toEqual([])
  })

  it('does not treat `$0`, `$#`, `$@` or named variables as positional parameters', () => {
    expect(uses('f() {\n  echo "$0 $# $@ $* $name $HOME"\n}\n')).toEqual([])
    expect(uses('f() {\n  echo "$0 $1"\n}\n')).toEqual([2])
  })
})

describe('checkShellFiles / main', () => {
  it('reports the rule key, path and line for every hit', () => {
    const problems = checkShellFiles(['a.sh'], () => 'f() {\n  echo "$1"\n}\n')
    expect(problems).toEqual([`${RULE_KEY} a.sh:2: echo "$1"`])
  })

  it('reports nothing for a clean file', () => {
    expect(checkShellFiles(['a.sh'], () => 'f() {\n  local a="$1"\n  echo "$a"\n}\n')).toEqual([])
  })

  it('exits 2 without arguments', () => {
    expect(main([])).toBe(2)
  })
})

describe('check-shell-positional-params CLI', () => {
  it('exits 1 with the rule key on a dirty file and 0 on a clean one', () => {
    const root = makeFixtureRoot()
    writeFixture(root, 'bad.sh', 'f() {\n  echo "$1"\n}\n')
    writeFixture(root, 'good.sh', 'f() {\n  local a="$1"\n  echo "$a"\n}\n')

    const bad = runScriptCli(SCRIPT, root, ['bad.sh'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('shelldre:S7679 bad.sh:2')

    const good = runScriptCli(SCRIPT, root, ['good.sh'])
    expect(good.status).toBe(0)
    expect(good.stdout).toContain('clean')
  })
})

describe('the repo shell scripts a story already fixed stay clean', () => {
  it('scripts/pr-e2e-smoke-gate.sh (66-20, fixed in 694ee09a) has no direct positional use', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, 'pr-e2e-smoke-gate.sh'), 'utf-8')
    expect(findPositionalParamUses(source)).toEqual([])
  })
})
