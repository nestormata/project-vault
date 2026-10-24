<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialsImportFlow } from './credentials-import-flow.svelte.js'

  // Story 69.11: the file picker that starts a secrets import.
  let {
    flow,
    data,
  }: {
    flow: CredentialsImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.upload -->
<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <label class="block font-medium text-slate-900" for="import-file">
    Select .env or JSON file
  </label>
  <input
    id="import-file"
    class="mt-3 block w-full text-sm"
    type="file"
    accept=".env,.json,text/plain,application/json"
    disabled={flow.uploading}
    onchange={(event) => void flow.selectFile(event)}
    aria-describedby="import-file-help"
  />
  <FormHelpText id="import-file-help" kind="text" />
  {#if flow.uploading}
    <p class="mt-3 text-sm text-slate-600">Parsing file…</p>
  {/if}<InjectionPoint name="project.credentials-import.upload" {data} />
</div>
