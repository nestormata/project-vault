import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Story 9.6 D3.2: atomic temp-file + rename write pattern, extracted out of `storage.ts`'s
 * `filesystemStorage()` (Story 9.1 AC-5) so the S3 destination's local staging write (`s3-upload.ts`)
 * can reuse the exact same "never leave a partially written file visible under its final name"
 * guarantee instead of reinventing it. A crash mid-write leaves only an orphaned `.tmp-*` file,
 * never a corrupted final file.
 *
 * `dirPath` is always operator-configured (`BACKUP_STORAGE_PATH`/`BACKUP_S3_STAGING_PATH`) or this
 * module's own generated filename, never raw user input.
 */
export async function atomicFileWrite(
  dirPath: string,
  filename: string,
  data: Buffer
): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see module doc comment above.
  await mkdir(dirPath, { recursive: true })
  const finalPath = join(dirPath, filename)
  const tmpPath = join(dirPath, `.tmp-${randomUUID()}-${filename}`)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see module doc comment above.
  await writeFile(tmpPath, data)
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see module doc comment above.
  await rename(tmpPath, finalPath)
}
