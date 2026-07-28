// House rule from Epic 5's retro (P5-1, raised 3x across Epics 5 and 14, never enforced until now):
// Fastify's Zod response serializer walks z.union([...]) members in array order and serializes
// against the first member whose required fields the data satisfies — a structural match, not an
// exact one. If ApiErrorSchema (the generic {code, message, details?} shape) is listed before a
// more specific error schema, a response satisfying both can silently serialize via the generic
// schema and drop the specific schema's extra fields on the wire.
export const noErrorSchemaFirstInUnion = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          genericSchemaNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const genericNames = new Set(context.options[0]?.genericSchemaNames ?? ['ApiErrorSchema'])
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'z' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'union'
        ) {
          return
        }
        const arrayArg = node.arguments[0]
        if (!arrayArg || arrayArg.type !== 'ArrayExpression') return

        const members = arrayArg.elements
        members.forEach((member, index) => {
          if (
            member &&
            member.type === 'Identifier' &&
            genericNames.has(member.name) &&
            index !== members.length - 1
          ) {
            context.report({
              node: member,
              message: `${member.name} must be the last member of z.union([...]) — Fastify's response serializer matches union members in order, so listing the generic error schema first can silently drop a more specific schema's extra fields.`,
            })
          }
        })
      },
    }
  },
}
