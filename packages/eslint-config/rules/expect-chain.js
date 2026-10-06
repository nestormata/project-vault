// Shared AST helper for the test-file rules (Story 66-17): finds the `expect(<arg>)` call behind a
// matcher call such as `expect(x).not.toBe(1)`.

function isNonComputedMember(node, propertyName) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    (propertyName === undefined || node.property.name === propertyName)
  )
}

function isSingleArgumentExpect(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'expect' &&
    node.arguments.length === 1 &&
    node.arguments[0].type !== 'SpreadElement'
  )
}

/**
 * For a matcher callee (`expect(x).toBe`, `expect(x).not.toBe`) whose matcher name is in
 * `matcherNames`, returns the `expect(x)` call node; otherwise `null`. `.resolves` / `.rejects`
 * chains and `expect.soft` are deliberately not followed.
 */
export function expectCallBehindMatcher(callee, matcherNames) {
  if (!isNonComputedMember(callee) || !matcherNames.has(callee.property.name)) return null
  const receiver = isNonComputedMember(callee.object, 'not') ? callee.object.object : callee.object
  return isSingleArgumentExpect(receiver) ? receiver : null
}

export { isNonComputedMember }
