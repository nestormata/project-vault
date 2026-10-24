<script lang="ts">
  import RotationNote from './RotationNote.svelte'

  // Story 69.14: the closing note of a retired or abandoned rotation.
  let { status }: { status: 'retired' | 'abandoned' } = $props()
</script>

{#if status === 'retired'}
  <RotationNote
    tone="emerald"
    text="This rotation is retired. The old value has been cryptographically deleted."
  />
{:else}
  <RotationNote
    tone="slate"
    text="This rotation was abandoned. The secret's previous value remains current."
  />
{/if}
