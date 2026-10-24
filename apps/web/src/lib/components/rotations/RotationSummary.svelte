<script lang="ts">
  import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { formatDateTime, rotationStatusBadgeClass } from './rotation-copy.js'
  import type { RotationDetailSectionProps } from './rotation-controller.svelte.js'

  // Story 69.14: the header card of the rotation detail page (status, dates, notes, Refresh and
  // the passive banners) as one replaceable region. The page renders it only with a loaded rotation.
  let { controller, rotation, data }: RotationDetailSectionProps = $props()
</script>

<!-- @region project.credentials-rotations-detail.summary -->
<RegionFragment>
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-2xl font-bold text-slate-950">Rotation</h1>
      <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
    </div>
    <p class="mt-2 text-sm text-slate-600">
      Initiated {formatDateTime(rotation.initiatedAt)}
      {#if rotation.completedAt}
        · Completed {formatDateTime(rotation.completedAt)}
      {/if}
    </p>
    {#if rotation.notes}
      <p class="mt-2 text-slate-700">{rotation.notes}</p>
    {/if}
    <button
      type="button"
      class="mt-3 text-sm font-medium text-slate-700 underline"
      onclick={() => void controller.refetch()}
    >
      Refresh
    </button>
    {#if controller.concurrentBanner}
      <p class="mt-2 text-sm text-amber-800" role="status">
        Someone else just updated this rotation. Refreshing…
      </p>
    {/if}
    {#if controller.pollSealedBanner}
      <p class="mt-2 text-sm text-red-800" role="alert">{onboardingCopy.vaultSealedMessage}</p>
    {/if}<InjectionPoint name="project.credentials-rotations-detail.summary" {data} />
  </div>
</RegionFragment>
