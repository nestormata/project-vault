<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import type { PlatformOrgCreate } from './platform-org-create.svelte.js'

  // Story 69.11: the outcome banners of the create-organization form (created, failed, MFA needed).
  let {
    create,
    data,
  }: {
    create: PlatformOrgCreate
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-orgs.create-status -->
<RegionFragment>
  {#if create.createSuccess}
    <p
      class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
      role="status"
    >
      {create.createSuccess}
    </p>
  {/if}
  {#if create.createError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {create.createError}
      {#if create.createError.includes('maximum')}
        <a href={resolve('/platform/settings')} class="ml-1 underline">→ Settings</a>
      {/if}
    </p>
  {/if}
  {#if create.createMfaError}
    <MfaAwareErrorAlert
      message={create.createMfaError}
      class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    />
  {/if}<InjectionPoint name="platform.settings-orgs.create-status" {data} />
</RegionFragment>
