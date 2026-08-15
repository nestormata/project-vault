/* eslint-disable security/detect-non-literal-fs-filename -- all paths are isolated temp fixtures. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeDeployRuntime } from './materialize-deploy-runtime.mjs'

const DOCKERFILE = join(process.cwd(), 'apps/api/Dockerfile')
const EXTENSION_PACKAGE = '@project-vault/extension-api'
const EXTENSION_VERSION = '1.1.0'
const SEMVER_PACKAGE = 'semver'
const SEMVER_VERSION = '7.8.5'
const PACKAGE_JSON = 'package.json'
const SEMVER_DEPLOY_PATH = 'node_modules/semver'

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

describe('deploy runtime materializer', () => {
  it('copies the packed extension-api dependency closure as regular files', () => {
    const root = mkdtempSync(join(tmpdir(), 'materialize-deploy-runtime-'))
    const extension = join(root, 'packed-extension-api')
    const semver = join(root, 'node_modules', 'semver')
    const deploy = join(root, 'deploy')

    mkdirSync(extension, { recursive: true })
    mkdirSync(semver, { recursive: true })
    writeJson(join(extension, PACKAGE_JSON), {
      name: EXTENSION_PACKAGE,
      version: EXTENSION_VERSION,
      dependencies: { [SEMVER_PACKAGE]: SEMVER_VERSION },
    })
    writeJson(join(semver, PACKAGE_JSON), { name: SEMVER_PACKAGE, version: SEMVER_VERSION })

    materializeDeployRuntime(deploy, root, [extension])

    expect(
      JSON.parse(readFileSync(join(deploy, SEMVER_DEPLOY_PATH, PACKAGE_JSON), 'utf8'))
    ).toMatchObject({
      version: SEMVER_VERSION,
    })
    expect(lstatSync(join(deploy, SEMVER_DEPLOY_PATH)).isSymbolicLink()).toBe(false)
  })

  it('keeps a packed package that is already inside the deploy root', () => {
    const root = mkdtempSync(join(tmpdir(), 'materialize-deploy-runtime-in-place-'))
    const deploy = join(root, 'deploy')
    const extension = join(deploy, 'node_modules/@project-vault/extension-api')
    const semver = join(root, 'node_modules', 'semver')

    mkdirSync(extension, { recursive: true })
    mkdirSync(semver, { recursive: true })
    writeJson(join(extension, PACKAGE_JSON), {
      name: EXTENSION_PACKAGE,
      version: EXTENSION_VERSION,
      dependencies: { [SEMVER_PACKAGE]: SEMVER_VERSION },
    })
    writeJson(join(semver, PACKAGE_JSON), { name: SEMVER_PACKAGE, version: SEMVER_VERSION })

    materializeDeployRuntime(deploy, root, [extension])

    expect(readFileSync(join(extension, PACKAGE_JSON), 'utf8')).toContain(EXTENSION_PACKAGE)
    expect(readFileSync(join(deploy, SEMVER_DEPLOY_PATH, PACKAGE_JSON), 'utf8')).toContain(
      SEMVER_VERSION
    )
  })

  it('walks the packed extension-api root in the Docker deploy closure', () => {
    const dockerfile = readFileSync(DOCKERFILE, 'utf8')
    const materializerInvocation = dockerfile.match(
      /RUN node scripts\/materialize-deploy-runtime\.mjs[\s\S]*?\n && node --input-type=module/
    )?.[0]

    expect(materializerInvocation).toContain('/app/packages/extension-api/node_modules/semver')
    expect(materializerInvocation).toContain(
      '/app/deploy/node_modules/@project-vault/extension-api'
    )
  })
})
