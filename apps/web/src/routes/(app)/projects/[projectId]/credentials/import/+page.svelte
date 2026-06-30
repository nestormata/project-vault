<script lang="ts">
  import { resolve } from '$app/paths'
  import {
    confirmCredentialImport,
    previewCredentialImport,
    type ImportPreview,
  } from '$lib/api/credentials.js'
  import { ApiClientError } from '$lib/api/client.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data } = $props()

  let step = $state<'upload' | 'preview' | 'done'>('upload')
  let preview = $state<ImportPreview | null>(null)
  let summary = $state<{ imported: number; newVersions: number; skipped: number } | null>(null)
  let uploading = $state(false)
  let confirming = $state(false)
  let errorMessage = $state<string | null>(null)

  async function handleFileSelect(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !data.canImport) return

    uploading = true
    errorMessage = null
    preview = null
    try {
      preview = await previewCredentialImport(fetch, data.projectId, file)
      step = 'preview'
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === 'import_too_large') {
          errorMessage = 'File is too large. Maximum size is 1 MB.'
        } else {
          errorMessage = error.message
        }
      } else {
        errorMessage = error instanceof Error ? error.message : 'Import preview failed.'
      }
    } finally {
      uploading = false
      input.value = ''
    }
  }

  async function confirmImport() {
    if (!preview || confirming || !data.canImport) return
    confirming = true
    errorMessage = null
    try {
      const result = await confirmCredentialImport(fetch, data.projectId, {
        importId: preview.importId,
        defaultAction: 'new_version',
      })
      summary = {
        imported: result.imported,
        newVersions: result.newVersions,
        skipped: result.skipped,
      }
      step = 'done'
      preview = null
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === 'import_expired' || error.code === 'import_not_found') {
          errorMessage = 'Preview expired — upload again.'
          step = 'upload'
          preview = null
        } else {
          errorMessage = error.message
        }
      } else {
        errorMessage = error instanceof Error ? error.message : 'Import confirm failed.'
      }
    } finally {
      confirming = false
    }
  }
</script>

<svelte:head>
  <title>Import credentials | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-3xl space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Bulk import</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Import credentials</h1>
    <p class="mt-2 text-slate-600">
      Upload a .env or JSON file. Values are never shown in preview.
    </p>
  </div>

  {#if !data.canImport}
    <AccessNotice
      title="Import not available"
      message="Bulk import requires Admin or Owner access. Ask your administrator to upgrade your role."
      backHref={`/projects/${data.projectId}/credentials`}
      backLabel="Back to credentials"
    />
  {:else if step === 'done' && summary}
    <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
      <h2 class="text-lg font-semibold text-emerald-900">Import complete</h2>
      <ul class="mt-3 space-y-1 text-emerald-800">
        <li>Imported: {summary.imported}</li>
        <li>New versions: {summary.newVersions}</li>
        <li>Skipped: {summary.skipped}</li>
      </ul>
      <a
        class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
        href={resolve(`/projects/${data.projectId}/credentials`)}
      >
        View credentials
      </a>
    </div>
  {:else if step === 'preview' && preview}
    <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Preview ({preview.itemCount} items)</h2>
      <div class="overflow-hidden rounded-xl border border-slate-200">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-3 font-semibold">Name</th>
              <th class="px-4 py-3 font-semibold">Value</th>
              <th class="px-4 py-3 font-semibold">Conflict</th>
              <th class="px-4 py-3 font-semibold">Suggested action</th>
            </tr>
          </thead>
          <tbody>
            {#each preview.parsed as item (item.name)}
              <tr class="border-b border-slate-100 last:border-b-0">
                <td class="px-4 py-3 font-medium">{item.name}</td>
                <td class="px-4 py-3 font-mono text-slate-600">{item.value}</td>
                <td class="px-4 py-3 text-slate-600">{item.conflictName ?? '—'}</td>
                <td class="px-4 py-3 text-slate-600">{item.suggestedAction}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap gap-3">
        <button
          class="rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white disabled:opacity-60"
          type="button"
          disabled={confirming}
          onclick={() => void confirmImport()}
        >
          {confirming ? 'Importing…' : 'Confirm import'}
        </button>
        <button
          class="rounded-xl border border-slate-300 px-4 py-3 font-semibold text-slate-900"
          type="button"
          onclick={() => {
            step = 'upload'
            preview = null
          }}
        >
          Upload different file
        </button>
      </div>
    </div>
  {:else}
    <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <label class="block font-medium text-slate-900" for="import-file">
        Select .env or JSON file
      </label>
      <input
        id="import-file"
        class="mt-3 block w-full text-sm"
        type="file"
        accept=".env,.json,text/plain,application/json"
        disabled={uploading}
        onchange={(event) => void handleFileSelect(event)}
      />
      {#if uploading}
        <p class="mt-3 text-sm text-slate-600">Parsing file…</p>
      {/if}
    </div>
  {/if}

  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}

  {#if data.canImport && step !== 'done'}
    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/credentials`)}
    >
      Back to credentials
    </a>
  {/if}
</section>
