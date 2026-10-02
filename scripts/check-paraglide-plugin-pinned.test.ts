import { createHash } from 'node:crypto'
import { openAsBlob, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  packedSettings,
  pluginPinProblems,
  type InlangSettings,
  type PluginLock,
} from './lib/web-host/inlang-plugins.js'

// Story 68.2 AC-5: Paraglide's message-format plugin is an exact-pinned npm devDependency of
// apps/web, loaded from node_modules by a relative path, so `paraglide compile` makes no network
// request and is reproducible. Before 68.2, project.inlang/settings.json fetched
// `@inlang/plugin-message-format@latest` from a CDN on every compile, and an offline compile
// silently produced no messages. Rules:
//   (a) no `modules` entry is an http(s) URL or names `@latest`;
//   (b) every entry is pinned in apps/web/inlang-plugins/plugins.lock.json;
//   (c) apps/web declares that plugin at exactly the pinned version;
//   (d) the installed file's sha256 equals the pin.
// The upgrade steps are in apps/web/inlang-plugins/README.md.

const repositoryRoot = join(import.meta.dirname, '..')
const WEB_DIR = join(repositoryRoot, 'apps', 'web')
const MESSAGE_FORMAT = '@inlang/plugin-message-format'
const MODULE = './node_modules/@inlang/plugin-message-format/dist/index.js'

const settings = JSON.parse(
  readFileSync(join(WEB_DIR, 'project.inlang', 'settings.json'), 'utf8')
) as InlangSettings
const lock = JSON.parse(
  readFileSync(join(WEB_DIR, 'inlang-plugins', 'plugins.lock.json'), 'utf8')
) as PluginLock
const webManifest = JSON.parse(readFileSync(join(WEB_DIR, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>
}

// Synthetic inputs for the self-tests: any 64-hex string is a well-formed sha256.
const FAKE_SHA = 'ab'.repeat(32)
const fakeLock: PluginLock = {
  [MESSAGE_FORMAT]: {
    version: '1.0.0',
    module: MODULE,
    packedAs: './inlang-plugins/plugin-message-format.js',
    sha256: FAKE_SHA,
  },
}
const fakeDeps = { [MESSAGE_FORMAT]: '1.0.0' }
const matching = (): string => FAKE_SHA
const run = (modules: string[], deps = fakeDeps, sha = matching) =>
  pluginPinProblems({ modules }, fakeLock, deps, sha)

describe('check-paraglide-plugin-pinned: rule self-tests (Story 68.2 AC-5)', () => {
  it('(a) fails on the pre-68.2 CDN @latest module and on an exact-version CDN URL', () => {
    const latest = run([
      'https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@latest/dist/index.js',
    ])
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatch(/never a URL or @latest/)
    expect(
      run(['https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4.4.4/dist/index.js'])
    ).toHaveLength(1)
  })

  it('(b) fails on a local module that is not pinned, and on empty modules', () => {
    expect(run(['./plugins/other.js'])[0]).toMatch(/not pinned in plugins\.lock\.json/)
    expect(run([])).toHaveLength(1)
  })

  it('(c) fails when apps/web declares a range or another version', () => {
    expect(run([MODULE], { [MESSAGE_FORMAT]: '^1.0.0' })[0]).toMatch(/the pin is exactly 1\.0\.0/)
    expect(run([MODULE], {})[0]).toMatch(/declares nothing/)
  })

  it('(d) fails when the installed file does not match its pin, naming the upgrade steps', () => {
    const problems = run([MODULE], fakeDeps, () => 'cd'.repeat(32))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('does not match the pinned')
    expect(problems[0]).toContain('plugins.lock.json')
    expect(run([MODULE], fakeDeps, () => undefined)[0]).toContain('(file missing)')
  })

  it('passes a pinned module at the exact version with a matching hash', () => {
    expect(run([MODULE])).toEqual([])
  })

  it('rewrites modules to the packed copy for the published package', () => {
    expect(packedSettings({ baseLocale: 'en', modules: [MODULE] }, fakeLock)).toEqual({
      baseLocale: 'en',
      modules: ['./inlang-plugins/plugin-message-format.js'],
    })
    expect(() => packedSettings({ modules: ['./x.js'] }, fakeLock)).toThrow(/not pinned/)
  })
})

describe('check-paraglide-plugin-pinned: this repo (Story 68.2 AC-5)', () => {
  let installedSha = ''

  beforeAll(async () => {
    const path = createRequire(join(WEB_DIR, 'package.json')).resolve(MESSAGE_FORMAT)
    const bytes = await (await openAsBlob(path)).arrayBuffer()
    installedSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  })

  it('loads the message-format plugin only from the exact-pinned, hash-pinned local package', () => {
    expect(Object.keys(lock)).toEqual([MESSAGE_FORMAT])
    const hashOf = (name: string): string | undefined =>
      name === MESSAGE_FORMAT ? installedSha : undefined
    expect(pluginPinProblems(settings, lock, webManifest.devDependencies, hashOf)).toEqual([])
  })
})
