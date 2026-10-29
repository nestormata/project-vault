<script lang="ts">
  import Dialog from '$lib/components/ui/Dialog.svelte'

  let { onclose, autofocusSecond = false }: { onclose?: () => void; autofocusSecond?: boolean } =
    $props()
  let open = $state(false)
  let mounted = $state(true)
</script>

<button type="button" onclick={() => (open = true)}>Open</button>
{#if mounted}
  <Dialog bind:open id="harness" title="Harness" {onclose}>
    <button type="button">First</button>
    <span data-autofocus={autofocusSecond ? '' : undefined}>
      <button type="button">Second</button>
    </span>
    <button type="button" onclick={() => (open = false)}>Close it</button>
    <button type="button" onclick={() => (mounted = false)}>Unmount dialog</button>
  </Dialog>
{/if}
