<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { CAPABILITY_DENIED_HELP_ID, CAPABILITY_DENIED_HELP_TEXT } from './capability-denied.js'

  // Story 69.3: the "No public status page has been created" card (enable button and, for an org
  // whose plan lacks the capability, the explanation) as one replaceable region. It renders only
  // when the page is disabled and the caller can manage it. A contribution at
  // `project.status-page.disabled` receives `{ project, capabilities, serviceEndpoints }` and renders inside the card.
  let {
    project,
    capabilities,
    serviceEndpoints,
    capabilityDenied,
    isBusy,
    onEnable,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    capabilityDenied: boolean
    isBusy: boolean
    onEnable: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.disabled -->
<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-slate-600">No public status page has been created for this project yet.</p>
  <button
    class="mt-4 rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    disabled={isBusy || capabilityDenied}
    aria-describedby={capabilityDenied ? CAPABILITY_DENIED_HELP_ID : undefined}
    onclick={() => onEnable()}
  >
    Enable public status page
  </button>
  {#if capabilityDenied}
    <FormHelpText id={CAPABILITY_DENIED_HELP_ID} text={CAPABILITY_DENIED_HELP_TEXT} />
  {/if}<InjectionPoint
    name="project.status-page.disabled"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
