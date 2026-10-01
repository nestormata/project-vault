<script lang="ts">
  // THROWAWAY: deliberate Svelte-only type error, proves the CI svelte-check gate fails (story 68-1 AC-4).
  const proof: number = 'not a number'
</script>

<p>{proof}</p>
