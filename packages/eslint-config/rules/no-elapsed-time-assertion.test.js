import { noElapsedTimeAssertion } from './no-elapsed-time-assertion.js'
import { ruleTester, tsTester } from './rule-testers.js'

const error = [{ messageId: 'elapsedTime' }]

ruleTester.run('no-elapsed-time-assertion', noElapsedTimeAssertion, {
  valid: [
    // Fake timers: the structural replacement for timeout tests.
    `vi.useFakeTimers()
     const settled = vi.fn()
     void run().then(settled)
     await vi.advanceTimersByTimeAsync(499)
     expect(settled).not.toHaveBeenCalled()
     await vi.advanceTimersByTimeAsync(1)
     expect(settled).toHaveBeenCalledTimes(1)`,
    // A single clock read used as a timestamp bound is not an elapsed delta.
    `const before = Date.now()
     const row = await insert()
     expect(row.createdAt.getTime()).toBeGreaterThan(before)`,
    // Clock read used to build a fixture.
    `const fixture = { expiresAt: new Date(Date.now() + 60_000) }
     expect(fixture.expiresAt).toBeInstanceOf(Date)`,
    // Subtraction of non-clock values.
    `const spent = totalMs - budgetMs
     expect(spent).toBeLessThan(10)`,
    // One operand is a clock read, the other a fixture value: not two reads.
    `const remaining = row.expiresAtMs - Date.now()
     expect(remaining).toBeGreaterThan(0)`,
    // Clock delta computed but never asserted on (logging only).
    `const t0 = performance.now()
     await work()
     log(performance.now() - t0)`,
    // Asserting on a counted quantity.
    `expect(counter.ops).toBeLessThan(2 * input.length)`,
    // Non-asserting matcher on a delta is not a bound or equality comparison.
    `const t0 = performance.now()
     expect(performance.now() - t0).toBeDefined()`,
    // Not an expect() call.
    `check(performance.now() - t0).toBeLessThan(5)`,
  ],
  invalid: [
    {
      code: `const started = performance.now()
             await work()
             expect(performance.now() - started).toBeLessThan(1000)`,
      errors: error,
    },
    {
      // The delta stored in a variable first is caught.
      code: `const start = Date.now()
             await work()
             const elapsed = Date.now() - start
             expect(elapsed).toBeLessThanOrEqual(500)`,
      errors: error,
    },
    {
      // Converted units are still a delta.
      code: `const t0 = performance.now()
             await work()
             const ms = (performance.now() - t0) / 1000
             expect(ms).toBeLessThan(1)`,
      errors: error,
    },
    {
      code: `const t0 = process.hrtime.bigint()
             await work()
             expect(Number(process.hrtime.bigint() - t0)).toBeLessThan(5e8)`,
      errors: error,
    },
    {
      // process.hrtime(previous) returns the delta directly.
      code: `const t0 = process.hrtime()
             await work()
             expect(process.hrtime(t0)[0]).toBe(0)
             expect(process.hrtime(t0)).toBeLessThan(1)`,
      errors: error,
    },
    {
      // Assigned later with a plain `let`.
      code: `let start
             start = performance.now()
             await work()
             expect(performance.now() - start).toBeGreaterThan(50)`,
      errors: error,
    },
    {
      // .not chain and equality / closeness matchers.
      code: `const s = Date.now()
             await work()
             expect(Date.now() - s).not.toBe(0)
             expect(Date.now() - s).toBeCloseTo(100, -1)`,
      errors: [{ messageId: 'elapsedTime' }, { messageId: 'elapsedTime' }],
    },
    {
      // Variable visible from an enclosing scope (closure).
      code: `const s = performance.now()
             it('x', async () => {
               await work()
               expect(performance.now() - s).toBeLessThan(10)
             })`,
      errors: error,
    },
  ],
})

tsTester.run('no-elapsed-time-assertion (TypeScript parser)', noElapsedTimeAssertion, {
  valid: [
    `const row = (await load()) as Row\nexpect(row.at.getTime()).toBeGreaterThan(Date.now())`,
  ],
  invalid: [
    {
      code: `const t0: number = performance.now()
             await work()
             const took = (performance.now() - t0) as number
             expect(took!).toBeLessThan(100)`,
      errors: error,
    },
  ],
})
