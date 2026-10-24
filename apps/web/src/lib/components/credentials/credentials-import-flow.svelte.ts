import { ApiClientError } from '$lib/api/client.js'
import {
  confirmCredentialImport,
  previewCredentialImport,
  type ImportPreview,
} from '$lib/api/credentials.js'

type ImportTarget = { projectId: string; canImport: boolean }

function previewErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.code === 'import_too_large'
      ? 'File is too large. Maximum size is 1 MB.'
      : error.message
  }
  return error instanceof Error ? error.message : 'Import preview failed.'
}

/**
 * Story 69.11: the one owner of the secrets import's upload -> preview -> done flow, created by
 * `CredentialsProjectImportContent` and handed to the step sub-regions (upload, preview, done) and
 * the error and back-link regions. `target` reads the page's project id and import permission.
 */
export class CredentialsImportFlow {
  step = $state<'upload' | 'preview' | 'done'>('upload')
  preview = $state<ImportPreview | null>(null)
  summary = $state<{ imported: number; newVersions: number; skipped: number } | null>(null)
  uploading = $state(false)
  confirming = $state(false)
  errorMessage = $state<string | null>(null)
  readonly #target: () => ImportTarget

  constructor(target: () => ImportTarget) {
    this.#target = target
  }

  async selectFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    const { projectId, canImport } = this.#target()
    if (!file || !canImport) return

    this.uploading = true
    this.errorMessage = null
    this.preview = null
    try {
      this.preview = await previewCredentialImport(fetch, projectId, file)
      this.step = 'preview'
    } catch (error) {
      this.errorMessage = previewErrorMessage(error)
    } finally {
      this.uploading = false
      input.value = ''
    }
  }

  async confirm(): Promise<void> {
    const { projectId, canImport } = this.#target()
    if (!this.preview || this.confirming || !canImport) return
    this.confirming = true
    this.errorMessage = null
    try {
      const result = await confirmCredentialImport(fetch, projectId, {
        importId: this.preview.importId,
        defaultAction: 'new_version',
      })
      this.summary = {
        imported: result.imported,
        newVersions: result.newVersions,
        skipped: result.skipped,
      }
      this.step = 'done'
      this.preview = null
    } catch (error) {
      this.confirmFailed(error)
    } finally {
      this.confirming = false
    }
  }

  restart(): void {
    this.step = 'upload'
    this.preview = null
  }

  private confirmFailed(error: unknown): void {
    if (error instanceof ApiClientError) {
      if (error.code === 'import_expired' || error.code === 'import_not_found') {
        this.errorMessage = 'Preview expired — upload again.'
        this.restart()
      } else {
        this.errorMessage = error.message
      }
    } else {
      this.errorMessage = error instanceof Error ? error.message : 'Import confirm failed.'
    }
  }
}
