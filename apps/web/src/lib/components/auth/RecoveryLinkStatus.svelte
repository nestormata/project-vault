<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { RecoveryStatus } from './recovery-reset.svelte.js'

  // Story 69.14: what the recovery page says while its link is checked and when the link cannot be
  // used (not found, expired, used, superseded, unreadable) as one replaceable region.
  let {
    status,
    data,
  }: {
    status: Exclude<RecoveryStatus, 'ready'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region auth.recovery-detail.status -->
<RegionFragment>
  {#if status === 'loading'}
    <p class="text-slate-600">Checking your recovery link...</p>
  {:else if status === 'not_found'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link not found</h1>
      <p class="text-slate-600">This recovery link doesn't exist. Request a new one.</p>
    </div>
  {:else if status === 'expired'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link expired</h1>
      <p class="text-slate-600">
        This link expired after 15 minutes. Request a new one to continue.
      </p>
    </div>
  {:else if status === 'used'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Recovery link already used</h1>
      <p class="text-slate-600">This link has already been used to reset your password.</p>
    </div>
  {:else if status === 'superseded'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">A newer recovery link was requested</h1>
      <p class="text-slate-600">
        A more recent recovery link superseded this one. Check your email for the latest link.
      </p>
    </div>
  {:else}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Something went wrong</h1>
      <p class="text-slate-600">We couldn't load this recovery link. Please try again.</p>
    </div>
  {/if}<InjectionPoint name="auth.recovery-detail.status" {data} />
</RegionFragment>
