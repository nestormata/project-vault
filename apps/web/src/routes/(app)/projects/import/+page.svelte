<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { importProject, type ImportProjectResult } from '$lib/api/project-export.js'

  let selectedFile = $state<File | null>(null)
  let exportKey = $state('')
  let projectName = $state('')
  let importing = $state(false)
  let errorMessage = $state<string | null>(null)
  let result = $state<ImportProjectResult | null>(null)

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

<svelte:head>
  <title>Import project | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Import project</h1>
    <p class="mt-2 text-slate-600">
      Upload a <code>.pvexport</code> file and its matching export key to create a brand-new project in
      your organization from it. This never merges into an existing project.
    </p>
  </div>

  {#if result}
    <div class="rounded-2xl border border-emerald-300 bg-emerald-50 p-6">
      <h2 class="text-lg font-semibold text-emerald-900">Import complete</h2>
      <p class="mt-2 text-sm text-emerald-800">
        Created <strong>{result.name}</strong> with
        {result.importedCounts['credentials'] ?? 0} secrets imported.
      </p>
      <button
        type="button"
        class="mt-4 rounded-lg bg-emerald-900 px-4 py-2 text-sm font-semibold text-white"
        onclick={goToImportedProject}
      >
        View project
      </button>
    </div>
  {:else}
    <form
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
        <input
          id="pvexport-file"
          type="file"
          accept=".pvexport"
          class="mt-1 block w-full text-sm"
          onchange={handleFileSelect}
          required
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-slate-800" for="export-key">Export key</label>
        <input
          id="export-key"
          type="text"
          class="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          bind:value={exportKey}
          placeholder="The one-time key shown when this file was exported"
          required
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
        />
      </div>

      <button
        type="submit"
        class="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!selectedFile || !exportKey.trim() || importing}
      >
        {importing ? 'Importing…' : 'Import project'}
      </button>
    </form>
  {/if}
</section>
