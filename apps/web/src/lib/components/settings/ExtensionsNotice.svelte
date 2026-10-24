<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: why the extension status is not shown (no Admin role, no MFA, or a failed fetch).
  let {
    allowed,
    mfaRequired,
    errorMessage,
    data,
  }: {
    allowed: boolean
    mfaRequired: boolean
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.extensions.notice -->
<RegionFragment>
  {#if !allowed}
    <!-- AC-5: 'owner' is deliberately included here too — this page's admin gate does not treat
         owner as admin-equivalent, mirroring the API's own allowedRoles: ['admin']. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">You need the Admin role to view extension status.</p>
      <a href={resolve('/settings')} class="mt-2 inline-block text-sm text-indigo-600 underline">
        ← Back to Settings
      </a>
    </div>
  {:else if mfaRequired}
    <!-- AC-7 edge: distinct from both the generic fetch-failure and the permission message —
         retrying won't help, enrolling in MFA will. -->
    <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p class="text-amber-900">Enable multi-factor authentication to view extension status.</p>
      <a
        href={resolve('/settings/security')}
        class="mt-2 inline-block text-sm font-medium text-indigo-600 underline"
      >
        Go to Security →
      </a>
    </div>
  {:else if errorMessage}
    <!-- AC-7: an honest, retry-worthy fetch failure — the rest of the page stays intact. -->
    <p
      class="mt-8 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}<InjectionPoint name="settings.extensions.notice" {data} />
</RegionFragment>
