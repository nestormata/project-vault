// Story 68.2 (Sonar tssecurity:S8705): `pnpm pack:web-host --tarball <dir>` hands <dir> to
// `npm pack --pack-destination`. It comes from the command line, so it is validated and turned
// into an absolute path before it reaches npm's argv: an absolute path always starts with `/`,
// so it can never be read as an npm option, and it is passed fused to its flag
// (`--pack-destination=<dir>`) so npm never takes it as a separate positional argument.
import { isAbsolute, resolve } from 'node:path'

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** The absolute directory `npm pack` writes the tarball to, or throws for an unsafe `--tarball`. */
export function packDestination(raw: string, cwd: string = process.cwd()): string {
  if (raw.trim() === '') throw new Error('--tarball needs a directory')
  if (raw.startsWith('-')) {
    throw new Error(`--tarball ${JSON.stringify(raw)} looks like an option, not a directory`)
  }
  if (hasControlCharacter(raw)) {
    throw new Error(`--tarball ${JSON.stringify(raw)} contains a control character`)
  }
  const absolute = resolve(cwd, raw)
  if (!isAbsolute(absolute)) throw new Error(`--tarball ${JSON.stringify(raw)} is not a path`)
  return absolute
}

/** npm's argv for packing the staged package into `destination` (already validated). */
export function npmPackArgs(npmCliPath: string, destination: string): string[] {
  return [npmCliPath, 'pack', '--json', `--pack-destination=${packDestination(destination)}`]
}
