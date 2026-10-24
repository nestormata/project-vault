<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { AuditVerifyRegionProps } from './audit-region-props.js'

  // Story 69.12: why the integrity check did not run (too many requests, a server message or a
  // generic failure).
  let { controller, pointProps, data }: AuditVerifyRegionProps = $props()
</script>

<!-- @region settings.audit.verify-error -->
<RegionFragment>
  {#if controller.errorMessage}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {controller.errorMessage}
    </p>
  {/if}<InjectionPoint name="settings.audit.verify-error" props={pointProps} {data} />
</RegionFragment>
