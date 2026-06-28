<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'

  let { data, children } = $props()
</script>

<AppShell user={data.user}>
  {@render children()}
</AppShell>
