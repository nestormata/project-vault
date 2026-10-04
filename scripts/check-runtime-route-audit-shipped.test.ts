// Story 68.23 AC-4: the runtime route audit stays shipped in the API image. A consumer runs the
// compiled entry with plain `node` (no tsx, no devDependency, no PV checkout), so this guard fails
// when the entry is not what `tsc` emits, when the image build prunes it, or when a document stops
// naming the command a consumer copies. Repository text is read through Vite (no dynamic fs path).
import { describe, expect, it } from 'vitest'
import { AUDIT_ENTRY } from './lib/shipped-route-audit.js'

const TEXT = import.meta.glob(
  [
    '../apps/api/Dockerfile',
    '../apps/api/tsconfig.json',
    '../apps/api/src/scripts/runtime-route-audit.ts',
    '../docs/composition-kit.md',
    '../docs/extensions/authoring.md',
    '../docs/container-images.md',
    '../docs/releasing.md',
    '../packages/composition-kit/README.md',
  ],
  { query: '?raw', import: 'default', eager: true }
)
const FILES = new Map(
  Object.entries(TEXT).map(([path, content]) => [path, String(content)] as const)
)

const text = (path: string): string => FILES.get(path) ?? ''

interface ApiTsconfig {
  compilerOptions: { outDir: string; rootDir: string }
  include: string[]
}

/** Where `tsc` writes `src/scripts/runtime-route-audit.ts`, from the API's own tsconfig. */
function compiledPathOfAuditSource(): string {
  const config = JSON.parse(text('../apps/api/tsconfig.json')) as ApiTsconfig
  const { outDir, rootDir } = config.compilerOptions
  expect(config.include.some((glob) => glob.startsWith(`${rootDir}/`))).toBe(true)
  return `${outDir}/scripts/runtime-route-audit.js`
}

describe('the runtime route audit entry stays shipped (Story 68.23 AC-4)', () => {
  it('has its source where the compiled path is derived from', () => {
    expect(text('../apps/api/src/scripts/runtime-route-audit.ts')).toContain(
      'export async function runCli'
    )
  })

  it('documents exactly the path tsc emits for that source', () => {
    expect(AUDIT_ENTRY).toBe(compiledPathOfAuditSource())
  })

  it('is not pruned by the image build, and the runner starts node on the compiled tree', () => {
    const dockerfile = text('../apps/api/Dockerfile')
    expect(dockerfile).toContain('pnpm --filter @project-vault/api deploy --prod --legacy')
    const pruning = dockerfile
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /dist\/scripts|scripts\/runtime-route-audit|\*\.js/.test(line))
      .filter((line) => /\b(rm|find)\b|-delete|-prune/.test(line))
    expect(pruning).toEqual([])
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]')
  })

  it.each([
    '../docs/composition-kit.md',
    '../docs/extensions/authoring.md',
    '../docs/container-images.md',
    '../docs/releasing.md',
    '../packages/composition-kit/README.md',
  ])('%s names the shipped command', (path) => {
    expect(text(path)).toContain(`node ${AUDIT_ENTRY}`)
  })
})
