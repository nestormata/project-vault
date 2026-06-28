<script lang="ts">
  import CrossProjectEmptyState from '$lib/components/dashboard/CrossProjectEmptyState.svelte'
  import DashboardPlaceholderGrid from '$lib/components/dashboard/DashboardPlaceholderGrid.svelte'
</script>

<svelte:head>
  <title>Dashboard | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  <CrossProjectEmptyState />
  <DashboardPlaceholderGrid />
</div>
