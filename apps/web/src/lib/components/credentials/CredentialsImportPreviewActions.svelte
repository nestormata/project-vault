<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialsImportFlow } from './credentials-import-flow.svelte.js'

  // Story 69.11: the confirm and start-over buttons of a secrets import preview.
  let {
    flow,
    data,
  }: {
    flow: CredentialsImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.preview-actions -->
<div class="flex flex-wrap gap-3">
  <button
    class="rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white disabled:opacity-60"
    type="button"
    disabled={flow.confirming}
    onclick={() => void flow.confirm()}
  >
    {flow.confirming ? 'Importing…' : 'Confirm import'}
  </button>
  <button
    class="rounded-xl border border-slate-300 px-4 py-3 font-semibold text-slate-900"
    type="button"
    onclick={() => flow.restart()}
  >
    Upload different file
  </button><InjectionPoint name="project.credentials-import.preview-actions" {data} />
</div>
