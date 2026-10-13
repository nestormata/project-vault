<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { importProject, type ImportProjectResult } from '$lib/api/project-export.js'
  import { ApiClientError } from '$lib/api/client.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { formatFileSize } from '$lib/utils/format-file-size.js'
  import * as m from '$lib/paraglide/messages.js'

  let { children }: { children?: Snippet } = $props()

  let selectedFile = $state<File | null>(null)
  let exportKey = $state('')
  let projectName = $state('')
  let importing = $state(false)
  let errorMessage = $state<string | null>(null)
  let result = $state<ImportProjectResult | null>(null)
  let showExportKey = $state(false)
  let exportKeyInput = $state<HTMLInputElement | null>(null)

  // Story 62-2 AC-4: fixed display order, independent of the API object's key order. A key the
  // API adds later with a positive count still renders (raw key as label) instead of vanishing.
  const COUNT_LABELS: ReadonlyArray<readonly [string, () => string]> = [
    ['credentials', m.project_import_count_credentials],
    ['credentialVersions', m.project_import_count_credential_versions],
    ['credentialDependencies', m.project_import_count_credential_dependencies],
    ['rotations', m.project_import_count_rotations],
    ['certRecords', m.project_import_count_cert_records],
    ['domainRecords', m.project_import_count_domain_records],
    ['serviceEndpoints', m.project_import_count_service_endpoints],
    ['statusPages', m.project_import_count_status_pages],
    ['machineUsers', m.project_import_count_machine_users],
  ]

  function isPositiveCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
  }

  function importedCountRows(
    counts: Record<string, number>
  ): Array<{ label: string; count: number }> {
    const known = new Set(COUNT_LABELS.map(([key]) => key))
    const rows = COUNT_LABELS.flatMap(([key, label]) => {
      const count = counts[key]
      return isPositiveCount(count) ? [{ label: label(), count }] : []
    })
    const unknown = Object.entries(counts).flatMap(([key, count]) =>
      !known.has(key) && isPositiveCount(count) ? [{ label: key, count }] : []
    )
    return [...rows, ...unknown]
  }

  // Story 62-4: file-picker display state. Only name/size metadata is read, never the contents.
  const fileDisplay = $derived(
    selectedFile ? { name: selectedFile.name, size: formatFileSize(selectedFile.size) } : null
  )
  const fileBadType = $derived(
    selectedFile !== null && !selectedFile.name.toLowerCase().endsWith('.pvexport')
  )

  const countRows = $derived(result ? importedCountRows(result.importedCounts) : [])

  function toggleExportKeyVisibility(): void {
    showExportKey = !showExportKey
    exportKeyInput?.focus()
  }
  function handleFileSelect(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    selectedFile = input.files?.[0] ?? null
  }
  // Story 28.9 AC-3 — three distinct, user-legible error cases, never one generic "import failed".
  function importErrorMessage(error: unknown): string {
    if (error instanceof ApiClientError) {
      if (error.code === 'import_decrypt_failed') {
        return 'This file could not be decrypted with the key you provided. Double-check the export key and try again.'
      }
      if (error.code === 'unsupported_export_format') {
        return error.message
      }
      if (error.code === 'invalid_export_payload') {
        return 'This file does not look like a valid Project Vault export.'
      }
      if (error.code === 'file_too_large') {
        return 'This export file is too large to import.'
      }
      return error.message
    }
    return error instanceof Error ? error.message : 'Import failed.'
  }
  async function onSubmit(): Promise<void> {
    if (!selectedFile || !exportKey.trim() || importing) return
    importing = true
    errorMessage = null
    result = null
    try {
      result = await importProject(
        fetch,
        selectedFile,
        exportKey.trim(),
        projectName.trim() || undefined
      )
      // AC-2: the key does not outlive a successful import (the success panel replaces the form).
      exportKey = ''
      showExportKey = false
    } catch (error) {
      errorMessage = importErrorMessage(error)
    } finally {
      importing = false
    }
  }
  function goToImportedProject(): void {
    if (!result) return
    void goto(resolve(`/projects/${result.projectId}`))
  }
</script>

{@render children?.()}
{#if result}
  <div class="rounded-2xl border border-emerald-300 bg-emerald-50 p-6">
    <h2 class="text-lg font-semibold text-emerald-900">Import complete</h2>
    <p class="mt-2 text-sm text-emerald-800">
      {m.project_import_success_intro()} <strong>{result.name}</strong>
    </p>
    {#if countRows.length > 0}
      <ul class="mt-2 list-disc pl-5 text-sm text-emerald-800">
        {#each countRows as row (row.label)}
          <li>{row.label}: {row.count}</li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-sm text-emerald-800">{m.project_import_no_items()}</p>
    {/if}
    <div class="mt-4 flex flex-wrap items-center gap-4">
      <button
        type="button"
        class="rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white"
        onclick={goToImportedProject}
      >
        View project
      </button>
      <a class="text-sm font-medium text-emerald-900 underline" href={resolve('/projects')}>
        {m.project_import_back_to_projects()}
      </a>
    </div>
  </div>
{:else}
  <form
    method="post"
    class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
    onsubmit={(event) => {
      event.preventDefault()
      void onSubmit()
    }}
  >
    {#if errorMessage}
      <p class="text-sm text-red-700">{errorMessage}</p>
    {/if}

    <div>
      <label class="block text-sm font-medium text-slate-800" for="pvexport-file">
        Export file (.pvexport)
      </label>
      <div
        class="mt-1 flex flex-wrap items-center gap-3 rounded-lg border p-3 {fileBadType
          ? 'border-red-600 bg-slate-50'
          : selectedFile
            ? 'border-solid border-slate-400 bg-slate-50'
            : 'border-dashed border-slate-300 bg-slate-50'}"
      >
        <input
          id="pvexport-file"
          type="file"
          accept=".pvexport"
          class="peer sr-only"
          onchange={handleFileSelect}
          required
          disabled={importing}
          aria-invalid={fileBadType ? 'true' : undefined}
          aria-describedby="pvexport-file-help"
        />
        <label
          for="pvexport-file"
          aria-hidden="true"
          aria-disabled={importing}
          class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-400 bg-white px-4 text-sm font-semibold text-slate-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-950 {importing
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-slate-100'}"
        >
          <svg
            class="h-4 w-4"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          >
            <path d="M10 13V3m0 0L6 7m4-4 4 4M3 13v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
          </svg>
          {selectedFile ? m.project_import_file_change() : m.project_import_file_choose()}
        </label>
        <span
          data-file-status
          aria-hidden="true"
          class="flex min-w-0 flex-1 items-center gap-1 text-sm text-slate-600"
        >
          {#if fileDisplay}
            <svg
              class="h-4 w-4 shrink-0 text-emerald-700"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="m4 10 4 4 8-8" />
            </svg>
            <span class="min-w-0 truncate" title="{fileDisplay.name} ({fileDisplay.size})"
              >{fileDisplay.name} ({fileDisplay.size})</span
            >
          {:else}
            {m.project_import_file_none()}
          {/if}
        </span>
        <span class="sr-only" role="status" aria-live="polite"
          >{fileDisplay ? m.project_import_file_selected(fileDisplay) : ''}</span
        >
      </div>
      {#if fileBadType}
        <p role="alert" class="mt-1 text-sm text-red-700">{m.project_import_file_bad_type()}</p>
      {/if}
      <FormHelpText id="pvexport-file-help" text={m.project_import_file_help()} />
    </div>

    <div>
      <label class="block text-sm font-medium text-slate-800" for="export-key">Export key</label>
      <div class="mt-1 flex items-center gap-2">
        <input
          id="export-key"
          type={showExportKey ? 'text' : 'password'}
          class="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          bind:value={exportKey}
          bind:this={exportKeyInput}
          placeholder="The one-time key shown when this file was exported"
          required
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          autocorrect="off"
          data-1p-ignore
          data-lpignore="true"
          aria-describedby="export-key-help"
        />
        <button
          type="button"
          class="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800"
          aria-pressed={showExportKey}
          aria-controls="export-key"
          onclick={toggleExportKeyVisibility}
        >
          {showExportKey ? m.project_import_export_key_hide() : m.project_import_export_key_show()}
        </button>
      </div>
      <FormHelpText
        id="export-key-help"
        kind="secret"
        text="The one-time decryption key you were shown when this export was created. It was never stored on the server, so it can't be recovered here — you must have saved it yourself."
      />
    </div>

    <div>
      <label class="block text-sm font-medium text-slate-800" for="project-name">
        Project name (optional override)
      </label>
      <input
        id="project-name"
        type="text"
        class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        bind:value={projectName}
        placeholder="Defaults to the exported project's own name"
        aria-describedby="project-name-help"
      />
      <FormHelpText
        id="project-name-help"
        text="Leave blank to keep the exported project's original name. Importing always creates a brand-new project — it never overwrites or merges into an existing one."
      />
    </div>

    <div class="flex flex-wrap items-center gap-4">
      <button
        type="submit"
        class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!selectedFile || !exportKey.trim() || importing}
      >
        {importing ? 'Importing…' : 'Import project'}
      </button>
      <a class="text-sm font-medium text-slate-700 underline" href={resolve('/projects')}>
        {m.project_import_back_to_projects()}
      </a>
    </div>
  </form>
{/if}
