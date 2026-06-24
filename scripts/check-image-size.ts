#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'

const MAX_BYTES = 300 * 1024 * 1024

const images = process.argv.slice(2)
if (images.length === 0) {
  process.stderr.write('Usage: check-image-size.ts <image:tag> [<image:tag> ...]\n')
  process.exit(1)
}

let failed = false

for (const image of images) {
  const output = execFileSync('docker', ['image', 'inspect', image, '--format={{.Size}}'], {
    encoding: 'utf-8',
  }).trim()
  const size = Number(output)

  if (!Number.isFinite(size)) {
    process.stderr.write(`ERROR: could not determine size of image ${image}\n`)
    failed = true
    continue
  }

  if (size > MAX_BYTES) {
    process.stderr.write(
      `FATAL: ${image} is ${size} bytes, exceeds ${MAX_BYTES} byte (300MB) limit\n`
    )
    failed = true
    continue
  }

  process.stdout.write(`check-image-size: ${image} is ${size} bytes — OK\n`)
}

if (failed) {
  process.exit(1)
}
