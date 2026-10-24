<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the submit and cancel actions of the start-rotation form as one replaceable region.
  let {
    form,
    projectId,
    credentialId,
    data,
  }: {
    form: RotateFormController
    projectId: string
    credentialId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-rotate.actions -->
<RegionFragment>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
    <button
      class="rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
      type="submit"
      disabled={form.submitting || form.rotationActive}
    >
      {form.submitting ? 'Starting…' : 'Start rotation'}
    </button>
    <a
      class="text-center font-medium text-slate-700 underline"
      href={resolve(`/projects/${projectId}/credentials/${credentialId}`)}
    >
      Cancel
    </a><InjectionPoint name="project.credentials-rotate.actions" {data} />
  </div>
</RegionFragment>
