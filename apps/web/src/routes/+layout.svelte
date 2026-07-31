<script lang="ts">
  import '../app.css'
  import NavigationProgressBar from '$lib/components/NavigationProgressBar.svelte'
  const { children } = $props()
</script>

<NavigationProgressBar />
{@render children()}
