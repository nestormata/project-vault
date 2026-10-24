<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { CAPABILITY_DENIED_HELP_ID, CAPABILITY_DENIED_HELP_TEXT } from './capability-denied.js'

  // Story 69.11: the save button of the status page admin card, disabled while busy or when the
  // organization's plan has no public status pages.
  let {
    project,
    capabilities,
    serviceEndpoints,
    capabilityDenied,
    isBusy,
    onSave,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    data?: Record<string, readonly unknown[]> | undefined
    capabilityDenied: boolean
    isBusy: boolean
    onSave: () => void | Promise<void>
  } = $props()
</script>

<!-- @region project.status-page.services-save -->
<RegionFragment>
  <button
    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    disabled={isBusy || capabilityDenied}
    aria-describedby={capabilityDenied ? CAPABILITY_DENIED_HELP_ID : undefined}
    onclick={() => onSave()}
  >
    Save services
  </button>
  {#if capabilityDenied}
    <FormHelpText id={CAPABILITY_DENIED_HELP_ID} text={CAPABILITY_DENIED_HELP_TEXT} />
  {/if}<InjectionPoint
    name="project.status-page.services-save"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</RegionFragment>
