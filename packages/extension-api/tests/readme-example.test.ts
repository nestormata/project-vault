import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '../src/index.js'

const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url))
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

/** Extracts the content of every ```ts fenced code block in a Markdown document, in order. */
function extractTsBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const regex = /```ts\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(markdown)) !== null) {
    const block = match[1]
    if (block) blocks.push(block)
  }
  return blocks
}

describe('README.md minimal extension example', () => {
  const readme = readFileSync(README_PATH, 'utf-8')
  const tsBlocks = extractTsBlocks(readme)

  it('contains at least one fenced ts block', () => {
    expect(tsBlocks.length).toBeGreaterThan(0)
  })

  // The regression this guards: a README example that hardcodes `apiVersion: '1.1.0'` compiles
  // fine and reads fine, but every host built after that literal's major floor rejects the
  // resulting extension at load time. The only correct value in a copy-pasteable example is the
  // imported constant, which moves with the installed package.
  it('never hardcodes an apiVersion string literal in an example code block', () => {
    for (const block of tsBlocks) {
      expect(block).not.toMatch(/apiVersion\s*:\s*['"`]/)
    }
  })

  it('declares apiVersion via the EXTENSION_API_VERSION constant', () => {
    const manifestBlock = tsBlocks.find((block) => block.includes('apiVersion'))
    expect(manifestBlock).toBeDefined()
    expect(manifestBlock).toMatch(/apiVersion\s*:\s*EXTENSION_API_VERSION/)
    // The constant must actually be imported in the same block, not merely referenced.
    expect(manifestBlock).toMatch(/import\s*\{[^}]*EXTENSION_API_VERSION/)
  })

  it('does not quote a bare semver literal anywhere in an example code block', () => {
    for (const block of tsBlocks) {
      expect(block).not.toMatch(/['"`]\d+\.\d+\.\d+['"`]/)
    }
  })

  it('does not pin the current package version into the README prose', () => {
    // A version string in prose is the same rot as a literal in the example: it silently becomes
    // wrong on the next release. Ranges are described symbolically instead.
    expect(readme).not.toContain(`\`${EXTENSION_API_VERSION}\``)
  })

  it('documents every capability, hook, and host service the contract exposes', () => {
    for (const capability of [
      'auth-provider',
      'notification-channel',
      'ui-panel',
      'capability-gate',
      'audit-event-source',
      'project-lifecycle',
      'delivery-provider',
      'project-archive-notify',
    ]) {
      expect(readme).toContain(capability)
    }
    for (const hook of [
      'authStrategy',
      'notificationChannel',
      'uiPanel',
      'capabilityGate',
      'projectLifecycle',
      'projectArchiveNotifier',
      'moduleAction',
      'moduleData',
      'deliveryProvider',
    ]) {
      expect(readme).toContain(hook)
    }
    for (const service of [
      'auditEventSource',
      'orgAuthorization',
      'projectAuthorization',
      'ephemeralState',
      'monitoring',
      'notificationOriginator',
    ]) {
      expect(readme).toContain(service)
    }
  })

  it('points at the generated surface snapshots instead of an inline export list', () => {
    expect(readme).toContain('api-surface.snapshot.md')
    expect(readme).toContain('contract-behaviour.snapshot.md')
  })

  it('ships both snapshots to npm consumers', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as { files: string[] }
    expect(pkg.files).toContain('api-surface.snapshot.md')
    expect(pkg.files).toContain('contract-behaviour.snapshot.md')
  })

  it('carries no private-overlay or internal-tracker references', () => {
    expect(readme).not.toContain('_bmad-output')
    expect(readme).not.toMatch(/\bStory \d+\.\d+\b/)
  })
})
