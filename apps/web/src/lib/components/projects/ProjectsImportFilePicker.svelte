<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import * as m from '$lib/paraglide/messages.js'
  import type { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the styled file picker of the project import form, with its wrong-type warning and
  // help text (the help is the input's `aria-describedby` target, so it lives in this file). Only the
  // name and size of the picked file are read, never its contents.
  let { flow }: { flow: ProjectImportFlow } = $props()
</script>

<div
  class="mt-1 flex flex-wrap items-center gap-3 rounded-lg border p-3 {flow.fileBadType
    ? 'border-red-600 bg-slate-50'
    : flow.selectedFile
      ? 'border-solid border-slate-400 bg-slate-50'
      : 'border-dashed border-slate-300 bg-slate-50'}"
>
  <input
    id="pvexport-file"
    type="file"
    accept=".pvexport"
    class="peer sr-only"
    onchange={(event) => flow.handleFileSelect(event)}
    required
    disabled={flow.importing}
    aria-invalid={flow.fileBadType ? 'true' : undefined}
    aria-describedby="pvexport-file-help"
  />
  <label
    for="pvexport-file"
    aria-hidden="true"
    aria-disabled={flow.importing}
    class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-400 bg-white px-4 text-sm font-semibold text-slate-900 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-slate-950 {flow.importing
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
    {flow.selectedFile ? m.project_import_file_change() : m.project_import_file_choose()}
  </label>
  <span
    data-file-status
    aria-hidden="true"
    class="flex min-w-0 flex-1 items-center gap-1 text-sm text-slate-600"
  >
    {#if flow.fileDisplay}
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
      <span class="min-w-0 truncate" title="{flow.fileDisplay.name} ({flow.fileDisplay.size})"
        >{flow.fileDisplay.name} ({flow.fileDisplay.size})</span
      >
    {:else}
      {m.project_import_file_none()}
    {/if}
  </span>
  <span class="sr-only" role="status" aria-live="polite"
    >{flow.fileDisplay ? m.project_import_file_selected(flow.fileDisplay) : ''}</span
  >
</div>
{#if flow.fileBadType}
  <p role="alert" class="mt-1 text-sm text-red-700">{m.project_import_file_bad_type()}</p>
{/if}
<FormHelpText id="pvexport-file-help" text={m.project_import_file_help()} />
