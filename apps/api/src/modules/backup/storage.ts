import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import type { BackupDestination } from './config.js'

export class BackupNotFoundOnDestinationError extends Error {}

export type BackupStorage = {
  write(filename: string, data: Buffer): Promise<void>
  read(filename: string): Promise<Buffer>
  delete(filename: string): Promise<void>
}

/** AC-5: atomic temp-file + rename write pattern — a partially written file is never visible
 * under its final name (a crash mid-write leaves only an orphaned `.tmp-*` file, never a
 * corrupted `.vault`/`.meta.json`). */
function filesystemStorage(path: string): BackupStorage {
  // path comes from BACKUP_STORAGE_PATH (operator-configured env var, not user input); filename
  // is either this module's own generated backup_<timestamp>_<instanceId>.vault or an admin-only
  // :filename route param already gated by requirePlatformOperator().
  return {
    async write(filename, data) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see filesystemStorage() comment above.
      await mkdir(path, { recursive: true })
      const finalPath = join(path, filename)
      const tmpPath = join(path, `.tmp-${randomUUID()}-${filename}`)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see filesystemStorage() comment above.
      await writeFile(tmpPath, data)
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see filesystemStorage() comment above.
      await rename(tmpPath, finalPath)
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

function s3Storage(destination: Extract<BackupDestination, { type: 's3' }>): BackupStorage {
  const client = new S3Client({
    region: destination.region ?? 'us-east-1',
    ...(destination.endpoint ? { endpoint: destination.endpoint, forcePathStyle: true } : {}),
  })
  return {
    async write(filename, data) {
      await client.send(
        new PutObjectCommand({ Bucket: destination.bucket, Key: filename, Body: data })
      )
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
