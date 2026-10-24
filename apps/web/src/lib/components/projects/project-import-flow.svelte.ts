import { goto } from '$app/navigation'
import { resolve } from '$app/paths'
import { ApiClientError } from '$lib/api/client.js'
import { importProject, type ImportProjectResult } from '$lib/api/project-export.js'
import { formatFileSize } from '$lib/utils/format-file-size.js'

const IMPORT_ERROR_MESSAGES = new Map<string, string>([
  [
    'import_decrypt_failed',
    'This file could not be decrypted with the key you provided. Double-check the export key and try again.',
  ],
  ['invalid_export_payload', 'This file does not look like a valid Project Vault export.'],
  ['file_too_large', 'This export file is too large to import.'],
])

// Story 28.9 AC-3 — three distinct, user-legible error cases, never one generic "import failed".
function importErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return (error.code ? IMPORT_ERROR_MESSAGES.get(error.code) : undefined) ?? error.message
  }
  return error instanceof Error ? error.message : 'Import failed.'
}

/**
 * Story 69.11: the one owner of the project import form state (picked file, export key, name
 * override, busy flag, error and result), created by `ProjectsImportContent` and handed to the
 * section sub-regions.
 */
export class ProjectImportFlow {
  selectedFile = $state<File | null>(null)
  exportKey = $state('')
  projectName = $state('')
  importing = $state(false)
  errorMessage = $state<string | null>(null)
  result = $state<ImportProjectResult | null>(null)
  showExportKey = $state(false)
  exportKeyInput = $state<HTMLInputElement | null>(null)

  // Story 62-4: file-picker display state. Only name/size metadata is read, never the contents.
  fileDisplay = $derived(
    this.selectedFile
      ? { name: this.selectedFile.name, size: formatFileSize(this.selectedFile.size) }
      : null
  )
  fileBadType = $derived(
    this.selectedFile !== null && !this.selectedFile.name.toLowerCase().endsWith('.pvexport')
  )

  toggleExportKeyVisibility(): void {
    this.showExportKey = !this.showExportKey
    this.exportKeyInput?.focus()
  }

  handleFileSelect(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    this.selectedFile = input.files?.[0] ?? null
  }

  async submit(): Promise<void> {
    if (!this.selectedFile || !this.exportKey.trim() || this.importing) return
    this.importing = true
    this.errorMessage = null
    this.result = null
    try {
      this.result = await importProject(
        fetch,
        this.selectedFile,
        this.exportKey.trim(),
        this.projectName.trim() || undefined
      )
      // AC-2: the key does not outlive a successful import (the success panel replaces the form).
      this.exportKey = ''
      this.showExportKey = false
    } catch (error) {
      this.errorMessage = importErrorMessage(error)
    } finally {
      this.importing = false
    }
  }

  goToImportedProject(): void {
    if (!this.result) return
    void goto(resolve(`/projects/${this.result.projectId}`))
  }
}
