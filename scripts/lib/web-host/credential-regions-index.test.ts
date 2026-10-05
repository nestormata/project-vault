import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../apps/web/guards/region-markup.js'
import { buildComponentIndex } from './component-index.js'

// Story 69.2 AC-9: the credential detail page's region components are replaceable by name (M4), and
// the two-level Shares design holds on the real tree: the `credential.detail.shares` point lives in the
// OUTER region, never in the INNER native body, so a pack that replaces the native sharer UI keeps its
// own fill. (The mock pack does not replace a credential region: PV's own page tests run over the
// composed tree and a replaced region would break them, see fixtures/mock-ui-pack/README.md.)

const WEB = resolve(import.meta.dirname, '../../../apps/web')
const DETAIL = 'src/lib/components/credentials/detail'

const REGION_COMPONENTS = [
  'CredentialArchiveActions',
  'CredentialBackLink',
  'CredentialDependencies',
  'CredentialLifecycleForm',
  'CredentialMetadataTiles',
  'CredentialNotFound',
  'CredentialRotationSection',
  'CredentialSharesNative',
  'CredentialSharesRegion',
  'CredentialSummary',
  'CredentialValueSection',
  'CredentialVaultSealed',
  'CredentialVersionHistory',
  'RotationRecommendedNudges',
] as const

// Loaded as raw text at transform time (the lint-clean loading pattern of the other wiring tests).
const SOURCES: Record<string, string> = import.meta.glob(
  '../../../apps/web/src/lib/components/credentials/detail/*.svelte',
  { query: '?raw', import: 'default', eager: true }
)

function source(name: string): string {
  const text = Object.entries(SOURCES).find(([path]) => path.endsWith(`/${name}.svelte`))?.[1]
  expect(text, `${name}.svelte must exist`).toBeDefined()
  return text ?? ''
}

describe('credential region components in the component index (Story 69.2)', () => {
  it('lists every region component (and the inner native sharer body) for M4 replacement', () => {
    const paths = new Set(buildComponentIndex(WEB).components.map((entry) => entry.path))
    for (const name of REGION_COMPONENTS) expect(paths, name).toContain(`${DETAIL}/${name}.svelte`)
  })

  it('keeps the shares point in the OUTER region, imported around the INNER native body', () => {
    const outer = parseMarkup(source('CredentialSharesRegion'), 'CredentialSharesRegion.svelte')
    expect(outer.points.map((point) => point.name)).toEqual(['credential.detail.shares'])
    expect([...outer.svelteImports.values()]).toContain('./CredentialSharesNative.svelte')
    const inner = parseMarkup(source('CredentialSharesNative'), 'CredentialSharesNative.svelte')
    expect(inner.points).toEqual([])
    expect(inner.regions).toEqual([])
  })

  it('has one component per region and no region component shared by two points', () => {
    const pointsByFile = new Map<string, string[]>()
    for (const name of REGION_COMPONENTS) {
      const parsed = parseMarkup(source(name), `${name}.svelte`)
      pointsByFile.set(
        name,
        parsed.points.flatMap((point) => (point.name === null ? [] : [point.name]))
      )
    }
    const seen = [...pointsByFile.values()].flat()
    expect(new Set(seen).size).toBe(seen.length)
  })
})
