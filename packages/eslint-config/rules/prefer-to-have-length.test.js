import { preferToHaveLength } from './prefer-to-have-length.js'
import { ruleTester, tsTester } from './rule-testers.js'

const error = [{ messageId: 'useToHaveLength' }]

ruleTester.run('prefer-to-have-length', preferToHaveLength, {
  valid: [
    // Already the preferred form.
    `expect(items).toHaveLength(3)`,
    // Non-equality matcher: no toHaveLength form exists.
    `expect(items.length).toBeGreaterThan(0)`,
    // `.size` is not `.length`.
    `expect(map.size).toBe(2)`,
    // Optional chain: undefined is a legal outcome, toHaveLength would throw on it.
    `expect(items?.length).toBe(3)`,
    // Computed access is out of scope.
    `expect(items['length']).toBe(3)`,
    // Not an expect() call.
    `assert.strictEqual(items.length, 3)`,
    `other(items.length).toBe(3)`,
    // Not the `length` property.
    `expect(items.count).toBe(3)`,
    // Not a bare property read of `length`.
    `expect(items.length + 1).toBe(3)`,
    `expect(items.length()).toBe(3)`,
    // Different matcher chain.
    `expect(items.length).resolves.toBe(3)`,
    `expect(items.length).toBeDefined()`,
    // Asymmetric matcher as the expected value: toHaveLength cannot take it.
    `expect(items.length).toEqual(expect.any(Number))`,
    // expect() with no or several arguments is not the assertion shape.
    `expect().toBe(3)`,
    `expect(...args).toBe(3)`,
  ],
  invalid: [
    {
      code: `expect(items.length).toBe(3)`,
      output: `expect(items).toHaveLength(3)`,
      errors: error,
    },
    {
      code: `expect(items.length).toEqual(3)`,
      output: `expect(items).toHaveLength(3)`,
      errors: error,
    },
    {
      code: `expect(items.length).toStrictEqual(someVar)`,
      output: `expect(items).toHaveLength(someVar)`,
      errors: error,
    },
    {
      // .not is preserved.
      code: `expect(x.length).not.toBe(0)`,
      output: `expect(x).not.toHaveLength(0)`,
      errors: error,
    },
    {
      // await expect(...) chains are preserved.
      code: `await expect(items.length).toBe(2)`,
      output: `await expect(items).toHaveLength(2)`,
      errors: error,
    },
    {
      // A call result is moved, not duplicated.
      code: `expect(getRows().length).toBe(2)`,
      output: `expect(getRows()).toHaveLength(2)`,
      errors: error,
    },
    {
      // Paired with the asymmetric-matcher valid case: a plain variable is still rewritten.
      code: `expect(items.length).toEqual(expected)`,
      output: `expect(items).toHaveLength(expected)`,
      errors: error,
    },
    {
      code: `expect(res.body.data.length).toBe(n)`,
      output: `expect(res.body.data).toHaveLength(n)`,
      errors: error,
    },
  ],
})

tsTester.run('prefer-to-have-length (TypeScript parser)', preferToHaveLength, {
  valid: [`expect((x as string[])?.length).toBe(2)`, `expect(x!.size).toBe(2)`],
  invalid: [
    {
      code: `expect((x as string[]).length).toBe(2)`,
      output: `expect(x as string[]).toHaveLength(2)`,
      errors: error,
    },
    {
      code: `expect(x!.length).toBe(2)`,
      output: `expect(x!).toHaveLength(2)`,
      errors: error,
    },
  ],
})
