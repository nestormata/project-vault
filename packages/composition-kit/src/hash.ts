import { createHash } from 'node:crypto'
import { readStream } from './fs-access.js'

/** SHA-256 over raw bytes, lowercase hex. Line endings are never normalized. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Streams a file through SHA-256 (large files are never read whole into memory). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of readStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
