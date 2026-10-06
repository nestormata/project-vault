// Story 66-17 (Epic 66 retro Finding 1): SonarCloud `typescript:S5906` only surfaced after push
// (66-15 PR #512, 68-9, 68-10). `expect(x.length).toBe(n)` fails with "expected 2 to be 3", which
// hides what `x` held; `expect(x).toHaveLength(n)` prints the collection.
//
// Reported: `expect(<x>.length).<toBe|toEqual|toStrictEqual>(<n>)`, optionally through `.not`.
// Autofix: moves `<x>` (never duplicates it, so a call result is still evaluated once) into
// `expect(...)` and renames the matcher to `toHaveLength`, keeping `.not`.
//
// Deliberately NOT reported:
//  - `expect(items?.length).toBe(3)`: with an optional chain `undefined` is a legal outcome,
//    while `toHaveLength` throws on `undefined`, so the rewrite would change semantics.
//  - `expect(x.length).toBeGreaterThan(0)` and other non-equality matchers: no `toHaveLength` form.
//  - `expect(map.size).toBe(2)`: `toHaveLength` reads `.length`, not `.size`.
//  - `.resolves` / `.rejects` chains and `expect.soft(...)`: out of scope (documented limit).
import { expectCallBehindMatcher, isNonComputedMember } from './expect-chain.js'

const EQUALITY_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual'])

function lengthOwner(argument) {
  return isNonComputedMember(argument, 'length') && !argument.optional ? argument.object : null
}

export const preferToHaveLength = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    schema: [],
    messages: {
      useToHaveLength:
        'Use expect(x).toHaveLength(n) instead of comparing x.length (SonarCloud S5906): the failure message then shows the collection.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    return {
      CallExpression(node) {
        const expectCall = expectCallBehindMatcher(node.callee, EQUALITY_MATCHERS)
        if (!expectCall) return
        const owner = lengthOwner(expectCall.arguments[0])
        if (!owner || owner.type === 'ChainExpression') return
        context.report({
          node,
          messageId: 'useToHaveLength',
          fix(fixer) {
            return [
              fixer.replaceText(expectCall.arguments[0], sourceCode.getText(owner)),
              fixer.replaceText(node.callee.property, 'toHaveLength'),
            ]
          },
        })
      },
    }
  },
}
