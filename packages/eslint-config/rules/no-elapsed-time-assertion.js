import { expectCallBehindMatcher, isNonComputedMember } from './expect-chain.js'

// Story 66-17 (Epic 66 retro Finding 8): wall-clock assertions failed the nightly three times in
// two days (43-9, 66-14, 66-15) and five more were ledgered as DW-434. A test that asserts
// `performance.now() - started < 1000` measures the CI host, not the code: a loaded runner turns
// it red, and "raising the number" is not a fix.
//
// Reported: `expect(<elapsed>).<bound or equality matcher>(...)` where `<elapsed>` is a subtraction
// of two clock reads (`performance.now()`, `Date.now()`, `process.hrtime.bigint()`), a
// `process.hrtime(previous)` call, an expression built from one of those (`/ 1e6`, `Number(...)`),
// or an identifier whose initialiser or assignment is such an expression.
//
// Not reported (legitimate): fake-timer tests (`vi.advanceTimersByTime...`), timestamp comparisons
// where only one operand is a clock read (`expect(row.createdAt.getTime()).toBeGreaterThan(before)`
// with `before = Date.now()` is a single read, not a subtraction of two reads), and clock reads
// used to build fixtures.
//
// Known limits (a syntactic rule cannot prove the absence of wall-clock tests, so code review
// remains the backstop): aliased clocks (`const { now } = performance`, `const t = Date.now`),
// results of helper functions (`expect(await measure())`, the `measureP95` shape), `.resolves` /
// `.rejects` chains and `expect.soft`. Flow is followed only through variables visible from the
// assertion's scope in the same file.
const CLOCK_METHODS = [
  ['performance', 'now'],
  ['Date', 'now'],
]
const ASSERTING_MATCHERS = new Set([
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBe',
  'toBeCloseTo',
  'toEqual',
  'toStrictEqual',
])
const NUMERIC_WRAPPERS = new Set(['Number', 'BigInt', 'parseFloat', 'parseInt'])
const MAX_DEPTH = 8

function isMember(node, objectName, propertyName) {
  return (
    isNonComputedMember(node, propertyName) &&
    node.object.type === 'Identifier' &&
    node.object.name === objectName
  )
}

function isClockMethodCall(callee) {
  return [...CLOCK_METHODS].some(([object, method]) => isMember(callee, object, method))
}

function isClockCall(node) {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  return (
    isClockMethodCall(callee) ||
    // process.hrtime.bigint()
    (isNonComputedMember(callee, 'bigint') && isMember(callee.object, 'process', 'hrtime')) ||
    // process.hrtime() / process.hrtime(previous)
    isMember(callee, 'process', 'hrtime')
  )
}

// `process.hrtime(previous)` already returns a delta.
function isHrtimeDelta(node) {
  return (
    node.type === 'CallExpression' &&
    isMember(node.callee, 'process', 'hrtime') &&
    node.arguments.length > 0
  )
}

export const noElapsedTimeAssertion = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      elapsedTime:
        'Do not assert on elapsed wall-clock time: it measures the CI host, not the code, and changing the number is not a fix. Assert the structural claim instead: what the code is handed (fake timers + advanceTimersByTimeAsync for timeouts, spy counts for "no overhead") or that work is bounded (counted operations over doubled input). See Story 66-8 / 66-14.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode

    function findVariable(identifier) {
      let scope = sourceCode.getScope(identifier)
      while (scope) {
        const variable = scope.set.get(identifier.name)
        if (variable) return variable
        scope = scope.upper
      }
      return null
    }

    function writesOf(identifier) {
      const variable = findVariable(identifier)
      if (!variable) return []
      return variable.references
        .filter((ref) => ref.isWrite() && ref.writeExpr)
        .map((r) => r.writeExpr)
    }

    // A value that is (or was assigned from) a raw clock read.
    function isClockValue(node, depth) {
      if (depth > MAX_DEPTH) return false
      if (isClockCall(node)) return true
      if (node.type === 'Identifier') {
        return writesOf(node).some((expr) => isClockValue(expr, depth + 1))
      }
      return false
    }

    function isElapsedBinary(node, depth) {
      if (node.operator === '-') {
        return isClockValue(node.left, depth + 1) && isClockValue(node.right, depth + 1)
      }
      return isElapsed(node.left, depth + 1) || isElapsed(node.right, depth + 1)
    }

    function isElapsedCall(node, depth) {
      if (isHrtimeDelta(node)) return true
      return (
        node.callee.type === 'Identifier' &&
        NUMERIC_WRAPPERS.has(node.callee.name) &&
        node.arguments.some((arg) => isElapsed(arg, depth + 1))
      )
    }

    // A value derived from a subtraction of clock reads.
    function isElapsed(node, depth) {
      if (depth > MAX_DEPTH) return false
      switch (node.type) {
        case 'BinaryExpression':
          return isElapsedBinary(node, depth)
        case 'CallExpression':
          return isElapsedCall(node, depth)
        case 'Identifier':
          return writesOf(node).some((expr) => isElapsed(expr, depth + 1))
        case 'TSAsExpression':
        case 'TSNonNullExpression':
          return isElapsed(node.expression, depth + 1)
        default:
          return false
      }
    }

    return {
      CallExpression(node) {
        const expectCall = expectCallBehindMatcher(node.callee, ASSERTING_MATCHERS)
        const argument = expectCall?.arguments[0]
        if (argument && isElapsed(argument, 0)) {
          context.report({ node: argument, messageId: 'elapsedTime' })
        }
      },
    }
  },
}
