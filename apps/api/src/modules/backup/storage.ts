import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { BackupDestination } from './config.js'
import { atomicFileWrite } from './atomic-write.js'
import { stageAndUploadToS3 } from './s3-upload.js'

export class BackupNotFoundOnDestinationError extends Error {}

export type BackupStorage = {
  write(filename: string, data: Buffer): Promise<void>
  read(filename: string): Promise<Buffer>
  delete(filename: string): Promise<void>
}

/** AC-5: atomic temp-file + rename write pattern (Story 9.6 D3.2: now the shared
 * `atomicFileWrite` helper in `atomic-write.ts`, also reused by the S3 destination's local
 * staging write) — a partially written file is never visible under its final name (a crash
 * mid-write leaves only an orphaned `.tmp-*` file, never a corrupted `.vault`/`.meta.json`). */
function filesystemStorage(path: string): BackupStorage {
  // path comes from BACKUP_STORAGE_PATH (operator-configured env var, not user input); filename
  // is either this module's own generated backup_<timestamp>_<instanceId>.vault or an admin-only
  // :filename route param already gated by requirePlatformOperator().
  return {
    async write(filename, data) {
      await atomicFileWrite(path, filename, data)
    },
    async read(filename) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- see filesystemStorage() comment above.
        return await readFile(join(path, filename))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new BackupNotFoundOnDestinationError(`No backup found with filename ${filename}`)
        }
        throw error
      }
    },
    async delete(filename) {
      await rm(join(path, filename), { force: true })
    },
  }
}

/** Story 9.6 D3: S3 destination hardening — `write()` now stages the encrypted bytes locally
 * first (atomic temp-file+rename, same pattern as `filesystemStorage()`), then uploads with
 * bounded retry (`stageAndUploadToS3` in `s3-upload.ts`), deleting the staged file on success and
 * retaining it on final failure (AC-12 through AC-15). `read()`/`delete()` are unchanged. */
function s3Storage(destination: Extract<BackupDestination, { type: 's3' }>): BackupStorage {
  const client = new S3Client({
    region: destination.region ?? 'us-east-1',
    ...(destination.endpoint ? { endpoint: destination.endpoint, forcePathStyle: true } : {}),
  })
  return {
    async write(filename, data) {
      await stageAndUploadToS3({ client, bucket: destination.bucket, filename, data })
    },
    async read(filename) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: destination.bucket, Key: filename })
        )
        const body = result.Body
        if (!body) throw new BackupNotFoundOnDestinationError(`Empty S3 object body: ${filename}`)
        const chunks: Buffer[] = []
        for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk))
        return Buffer.concat(chunks)
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchKey') {
          throw new BackupNotFoundOnDestinationError(`No backup found with filename ${filename}`)
        }
        throw error
      }
    },
    async delete(filename) {
      await client.send(new DeleteObjectCommand({ Bucket: destination.bucket, Key: filename }))
    },
  }
}

export function backupStorageFor(destination: BackupDestination): BackupStorage {
  return destination.type === 'filesystem'
    ? filesystemStorage(destination.path)
    : s3Storage(destination)
}
