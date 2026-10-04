<script lang="ts">
  // Story 69.1, M3 at a REGION point inside a PAGE THE PACK OVERRIDES: the mock dashboard override
  // imports PV's `RecentActivitySection`, so `dashboard.home.activity` renders inside the override and
  // receives this fill (the shape of CentralizeMe's override that builds on PV's region components).
  let {
    data = null,
    project = null,
  }: {
    data?: { marker?: string } | null
    project?: { id?: string } | null
  } = $props()
</script>

<p data-testid="mock-activity-tile" data-project={project?.id ?? ''}>
  {data?.marker ?? 'none'}
</p>
