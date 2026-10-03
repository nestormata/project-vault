<script lang="ts">
  let { data = null }: { data?: unknown } = $props()
</script>

<svelte:head>
  <meta name="x" content={data === null ? 'y' : 'z'} />
</svelte:head>
