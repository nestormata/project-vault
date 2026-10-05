<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import PublicStatusTitle from './PublicStatusTitle.svelte'

  // Story 69.3: the heading of a valid public status page as one replaceable region. It renders for
  // a valid token only (the invalid-token state has its own region). A contribution at
  // `status.detail.header` receives the standard props only and renders right after the heading.
  // This route is anonymous: no component here may need `locals.user`.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region status.detail.header -->
<RegionFragment>
  <PublicStatusTitle /><InjectionPoint name="status.detail.header" {data} />
</RegionFragment>
