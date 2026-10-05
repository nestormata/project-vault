import { pathToFileURL } from 'node:url'

// The output channel and the option reader the `check-*` CLIs that take an injectable `Io` share
// (story 69.5 factored them out of `check-monolithic-regions.ts` so `check-route-regions.ts` does not
// repeat them).
export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

export const STD_IO: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

export function option(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** Prints `FATAL: <heading>:` and one indented line per problem; the CLI's failing exit code. */
export function failWith(io: Io, heading: string, problems: readonly string[]): number {
  io.err(`FATAL: ${heading}:\n`)
  for (const problem of problems) io.err(`  ${problem}\n`)
  return 1
}

/** Runs `run` with the process arguments when the CLI file is the entry point. */
export function runAsMain(metaUrl: string, run: (args: string[]) => number): void {
  if (metaUrl === pathToFileURL(process.argv[1] ?? '').href) {
    process.exitCode = run(process.argv.slice(2))
  }
}
