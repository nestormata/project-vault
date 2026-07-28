import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noContiguousAllowedRoles } from './no-contiguous-allowed-roles.js'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('no-contiguous-allowed-roles', noContiguousAllowedRoles, {
  valid: [
    // Contiguous-from-the-top, but carries an explanatory comment — allowed.
    `const security = {
      // Explanatory comment: kept as allowedRoles deliberately, not a lint violation.
      allowedRoles: ['owner', 'admin'],
    }`,
    // Genuinely non-contiguous (excludes a higher rank, includes a lower one) — allowed,
    // no comment required since order can't be "wrong" when the set itself is the exception.
    `const security = { allowedRoles: ['admin', 'viewer'] }`,
    // Single-element array — never contiguous (nothing to be contiguous relative to),
    // matching status-routes.ts's real allowedRoles: ['admin'] exception.
    `const security = { allowedRoles: ['admin'] }`,
    // Not inside a `security` object at all — out of scope for this rule.
    `const notSecurity = { allowedRoles: ['owner', 'admin'] }`,
    // Not an array literal (e.g. a shared constant reference) — nothing to statically check.
    `const security = { allowedRoles: someSharedRolesConstant }`,
    // Spread expression inside the array — bail out, don't crash or false-flag.
    `const security = { allowedRoles: [...someRoles, 'owner'] }`,
    // Non-string-literal element (e.g. an identifier) — bail out, don't crash or false-flag.
    `const security = { allowedRoles: [OWNER_ROLE, 'admin'] }`,
    // Unrecognized role string — bail out rather than assuming a rank.
    `const security = { allowedRoles: ['owner', 'not-a-real-role'] }`,
  ],
  invalid: [
    {
      code: `const security = { allowedRoles: ['owner', 'admin'] }`,
      errors: [
        {
          message:
            "allowedRoles: ['owner', 'admin'] is contiguous from the top of the role hierarchy (expressible as minimumRole: 'admin') with no explanatory comment — use minimumRole instead, or add a comment explaining the non-contiguous exception.",
        },
      ],
    },
    {
      // Full 4-role contiguous array is also invalid — still expressible as minimumRole: 'viewer'.
      code: `const security = { allowedRoles: ['owner', 'admin', 'member', 'viewer'] }`,
      errors: [
        {
          message:
            "allowedRoles: ['owner', 'admin', 'member', 'viewer'] is contiguous from the top of the role hierarchy (expressible as minimumRole: 'viewer') with no explanatory comment — use minimumRole instead, or add a comment explaining the non-contiguous exception.",
        },
      ],
    },
  ],
})
