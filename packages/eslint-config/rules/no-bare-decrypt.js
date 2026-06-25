export const noBareDecrypt = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          blockedNames: { type: 'array', items: { type: 'string' } },
          allowNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const blockedNames = context.options[0]?.blockedNames ?? ['decrypt', 'bootstrapDecrypt']
    const allowNames = new Set(context.options[0]?.allowNames ?? [])
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return
        const name = node.callee.name
        if (!blockedNames.includes(name) || allowNames.has(name)) return
        context.report({ node, message: `Bare ${name}() call forbidden — use withSecret()` })
      },
      ImportSpecifier(node) {
        const name = node.imported.name
        if (blockedNames.includes(name) && !allowNames.has(name)) {
          context.report({ node, message: `Import of ${name} forbidden outside bootstrap callers` })
        }
      },
    }
  },
}
