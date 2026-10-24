import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensureDir, renameAt, writeFileAt } from '../../lib/fs-access.js'

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
  await ensureDir(dirPath)
  const finalPath = join(dirPath, filename)
  const tmpPath = join(dirPath, `.tmp-${randomUUID()}-${filename}`)
  await writeFileAt(tmpPath, data)
  await renameAt(tmpPath, finalPath)
}
