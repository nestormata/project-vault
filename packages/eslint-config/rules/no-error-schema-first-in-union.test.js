import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import { noErrorSchemaFirstInUnion } from './no-error-schema-first-in-union.js'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('no-error-schema-first-in-union', noErrorSchemaFirstInUnion, {
  valid: [
    // Generic schema last — the correct convention.
    'z.union([ActiveRotationsErrorSchema, ApiErrorSchema])',
    // Generic schema last, 3+ members.
    'z.union([FooSchema, BarSchema, ApiErrorSchema])',
    // Only one member — nothing to order.
    'z.union([ApiErrorSchema])',
    // Not a z.union call at all.
    'z.object({ code: z.string() })',
    // A same-named `union` call on a different receiver isn't Zod's z.union.
    'notZ.union([ApiErrorSchema, ActiveRotationsErrorSchema])',
    // Non-identifier members (e.g. spreads) are ignored, not crashed on.
    'z.union([...schemas, ApiErrorSchema])',
    // No arguments at all — don't crash on z.union().
    'z.union()',
    // Argument isn't an array literal (e.g. a variable) — nothing to reorder statically.
    'z.union(someSchemaArray)',
  ],
  invalid: [
    {
      code: 'z.union([ApiErrorSchema, ActiveRotationsErrorSchema])',
      errors: [
        {
          message:
            "ApiErrorSchema must be the last member of z.union([...]) — Fastify's response serializer matches union members in order, so listing the generic error schema first can silently drop a more specific schema's extra fields.",
        },
      ],
    },
    {
      // Generic schema in the middle of a 3-member union is also invalid.
      code: 'z.union([FooSchema, ApiErrorSchema, BarSchema])',
      errors: [{ message: /ApiErrorSchema must be the last member/ }],
    },
    {
      // Custom genericSchemaNames option is honored.
      code: 'z.union([SomeGenericSchema, SpecificSchema])',
      options: [{ genericSchemaNames: ['SomeGenericSchema'] }],
      errors: [{ message: /SomeGenericSchema must be the last member/ }],
    },
  ],
})
