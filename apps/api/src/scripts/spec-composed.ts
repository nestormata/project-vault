import { dirname, resolve } from 'node:path'
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AppOptions } from '../app.js'
import type { FastifyApp } from '../lib/fastify-app.js'
import type { ExtensionState } from '../extensions/loader.js'
import { DB_FREE_LOADER_DEPS, flagPairs, isBarePackageSpecifier } from './script-shared.js'

/**
 * Story 68.14 AC-3 — `generate-spec --extension <package> --out <path>`: CentralizeMe's composed
 * OpenAPI snapshot. The committed `packages/shared/openapi.json` stays PV-only: this mode loads the
 * extension through the real loader (DB-free: the loader's DB steps are stubbed), writes the
 * composed document to `--out`, and refuses an `--out` that resolves to PV's spec through any
 * spelling (relative, `..`, `//`, symlink or hard link).
 */

export const SPEC_USAGE =
  'usage: generate-spec [--extension <package> --out <path>]  (both flags together, or neither)'

/** A usage or `--out` defect (exit code 2). */
export class SpecUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecUsageError'
  }
}

/** The extension did not load (exit code 1). */
export class SpecLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecLoadError'
  }
}

export type SpecArgs = { mode: 'pv' } | { mode: 'composed'; extension: string; out: string }

const SPEC_FLAGS = new Set(['--extension', '--out'])

function collectSpecFlags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const [flag, value] of flagPairs(argv)) {
    if (!SPEC_FLAGS.has(flag)) throw new SpecUsageError(`unknown argument "${flag}"`)
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new SpecUsageError(`${flag} needs a value`)
    }
    if (parsed.has(flag)) throw new SpecUsageError(`${flag} was given more than once`)
    parsed.set(flag, value)
  }
  return parsed
}

export function parseSpecArgs(argv: readonly string[]): SpecArgs {
  const parsed = collectSpecFlags(argv)
  const extension = parsed.get('--extension')
  const out = parsed.get('--out')
  if (extension === undefined && out === undefined) return { mode: 'pv' }
  if (extension === undefined || out === undefined) {
    throw new SpecUsageError('--extension and --out must be given together')
  }
  if (!isBarePackageSpecifier(extension)) {
    throw new SpecUsageError('--extension must be a bare package specifier (not a path or URL)')
  }
  return { mode: 'composed', extension, out }
}

type FileId = { dev: number; ino: number }

function fileIdOf(path: string): FileId | undefined {
  if (!existsSync(path)) return undefined
  const { dev, ino } = statSync(path)
  return { dev, ino }
}

function isSameFile(left: FileId | undefined, right: FileId | undefined): boolean {
  return left?.dev !== undefined && left.dev === right?.dev && left.ino === right?.ino
}

/**
 * Resolves `--out` to an absolute path and refuses anything that could overwrite PV's spec: the
 * same path after normalization, or the same file by device and inode (a symlink or hard link).
 * The generator creates no directories: the parent must exist, and `--out` must not be one.
 */
export function resolveOutPath(out: string, pvSpecPath: string): string {
  const absolute = resolve(out)
  const parent = dirname(absolute)
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new SpecUsageError('--out parent directory must exist')
  }
  if (existsSync(absolute) && statSync(absolute).isDirectory()) {
    throw new SpecUsageError('--out is a directory')
  }
  if (absolute === resolve(pvSpecPath) || isSameFile(fileIdOf(absolute), fileIdOf(pvSpecPath))) {
    throw new SpecUsageError(
      '--out resolves to the PV committed spec, which this mode never writes'
    )
  }
  return absolute
}

/** Writes through a same-directory temp file and a rename: no partially written document. */
export function writeFileAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content, { mode: 0o644 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export type SpecDeps = {
  createApp: (options: AppOptions) => Promise<FastifyApp>
  getExtensionStatus: () => ExtensionState
}

/**
 * Boots the app with the extension and returns the composed OpenAPI document as text. A boot
 * failure (for example override drift) propagates; an extension that did not load is a
 * `SpecLoadError` carrying the loader's fixed reason.
 */
export async function generateComposedSpec(
  args: { extension: string },
  deps: SpecDeps
): Promise<string> {
  const app = await deps.createApp({
    logger: false,
    extension: { packageName: args.extension, loaderDeps: DB_FREE_LOADER_DEPS },
  })
  try {
    await app.ready()
    const status = deps.getExtensionStatus()
    if (status.status !== 'loaded') {
      const reason = status.status === 'load_failed' ? status.reason : status.status
      throw new SpecLoadError(`extension ${args.extension} did not load: ${reason}`)
    }
    return `${JSON.stringify(app.swagger(), null, 2)}\n`
  } finally {
    await app.close()
  }
}
