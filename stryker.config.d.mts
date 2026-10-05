// Type contract for stryker.config.mjs, consumed by scripts/check-stryker-config.test.ts (Story
// 66-16; it replaces a type-check suppression). TypeScript resolves this sibling declaration for the .mjs
// import. It declares the fields the gate test reads; `@stryker-mutator/api` is not a direct
// dependency, so its PartialStrykerOptions cannot be imported here. Every other option stays
// `unknown` through the index signature, so the test cannot rely on an undeclared field.
export declare const SHARDS: { api: string[]; db: string[] }

declare const config: {
  testRunner: string
  coverageAnalysis: string
  plugins: string[]
  dryRunTimeoutMinutes: number
  thresholds: { high: number; low: number; break: number }
  mutate: string[]
  [option: string]: unknown
}
export default config
