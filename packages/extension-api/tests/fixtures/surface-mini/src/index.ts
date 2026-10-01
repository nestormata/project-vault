// Story 66-6 fixture: a tiny package whose public surface exercises every renderer branch in
// tests/api-surface.ts (members, readonly/optional modifiers, index and call signatures,
// unions, intersections, arrays, tuples, recursion, value exports). It is compiled with
// `lib: ["es5"]` and no @types so each in-process build stays in the millisecond range.

export interface Probe {
  readonly id: string
  tags?: string[]
  list: string[]
  pair: [string, number]
  [key: string]: unknown
  run(): void
}

export interface Chain {
  value: number
  head: Chain
  next?: Chain
}

export interface Left {
  left: string
}

export interface Right {
  right: number
}

export type Choice = 'a' | 'b'

export type Both = Left & Right

export function greet(name: string): string {
  return `hello ${name}`
}
