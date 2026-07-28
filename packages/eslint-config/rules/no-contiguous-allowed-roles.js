// House rule from Epic 14's retro (Finding 3, Story 14.8): the minimumRole-vs-allowedRoles
// judgment call was independently re-derived three times (14-2, 14-5, 14-6) and never promoted
// to an enforced convention, letting apps/api/src/modules/org/routes.ts accumulate inconsistent
// allowedRoles usage with no stated rule. architecture.md's "RBAC Role-Gate Convention"
// (Enforcement Guidelines) now documents: default to minimumRole for any "this role or higher"
// gate; reserve allowedRoles for a genuinely non-contiguous set, with an explanatory comment.
// This rule flags the anti-pattern directly: an allowedRoles array that is contiguous from the
// top of the role hierarchy (i.e. fully expressible as minimumRole) with no adjacent comment.
const RANK_ORDER = ['owner', 'admin', 'member', 'viewer']

function isSecurityObjectProperty(property) {
  const parent = property.parent
  if (!parent || parent.type !== 'ObjectExpression') return false
  const grandparent = parent.parent
  if (!grandparent) return false
  if (grandparent.type === 'Property' && grandparent.key.type === 'Identifier') {
    return grandparent.key.name === 'security'
  }
  if (grandparent.type === 'VariableDeclarator' && grandparent.id.type === 'Identifier') {
    return grandparent.id.name === 'security'
  }
  return false
}

/** Resolves an ArrayExpression's elements to role names, or null if any element isn't a plain
 * string literal (spreads, identifiers, non-string literals) — the caller bails out on null
 * rather than crash or guess at a rank. */
function resolveRoleNames(elements) {
  const roleNames = []
  for (const element of elements) {
    if (!element || element.type !== 'Literal' || typeof element.value !== 'string') return null
    roleNames.push(element.value)
  }
  return roleNames
}

/** Ranks are indices into RANK_ORDER (0 = owner .. 3 = viewer), so "top" is rank 0.
 * "Contiguous from the top" = expressible as minimumRole: the set of ranks present, sorted
 * ascending, must be exactly {0, 1, ..., k} for some k — no gaps, starting at 0. Returns null if
 * any role name is unrecognized or the set isn't contiguous-from-top. */
function contiguousFromTopRanks(roleNames) {
  const ranks = roleNames.map((name) => RANK_ORDER.indexOf(name))
  if (ranks.some((rank) => rank === -1)) return null

  const uniqueSorted = [...new Set(ranks)].sort((a, b) => a - b)
  const isContiguousFromTop = uniqueSorted[0] === 0 && uniqueSorted.every((r, i) => r === i)
  return isContiguousFromTop ? uniqueSorted : null
}

function reportContiguousAllowedRoles(context, arrayNode, roleNames, ranks) {
  const lowestRank = ranks[ranks.length - 1]
  const minimumRoleName = RANK_ORDER[lowestRank]
  const arrayText = `[${roleNames.map((r) => `'${r}'`).join(', ')}]`

  context.report({
    node: arrayNode,
    message: `allowedRoles: ${arrayText} is contiguous from the top of the role hierarchy (expressible as minimumRole: '${minimumRoleName}') with no explanatory comment — use minimumRole instead, or add a comment explaining the non-contiguous exception.`,
  })
}

export const noContiguousAllowedRoles = {
  meta: {
    type: 'problem',
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        if (node.key.type !== 'Identifier' || node.key.name !== 'allowedRoles') return
        if (!isSecurityObjectProperty(node)) return

        const arrayArg = node.value
        if (!arrayArg || arrayArg.type !== 'ArrayExpression') return

        const elements = arrayArg.elements
        // Single-element arrays are never "contiguous" — there is nothing to be contiguous
        // relative to (matches status-routes.ts's real allowedRoles: ['admin'] exception).
        if (elements.length <= 1) return

        const roleNames = resolveRoleNames(elements)
        if (!roleNames) return

        const contiguousRanks = contiguousFromTopRanks(roleNames)
        if (!contiguousRanks) return

        const hasExplanatoryComment = context.sourceCode.getCommentsBefore(node).length > 0
        if (hasExplanatoryComment) return

        reportContiguousAllowedRoles(context, arrayArg, roleNames, contiguousRanks)
      },
    }
  },
}
