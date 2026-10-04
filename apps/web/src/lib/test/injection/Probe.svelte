<script lang="ts">
  // A contribution that records everything it was given: the names of the props it received and
  // their values, as JSON, so a test can assert what a region point exposes and what it never does.
  const received: Record<string, unknown> = $props()
  const keys = $derived(Object.keys(received).sort())
</script>

<p data-testid="probe" data-keys={keys.join(',')}>{JSON.stringify(received)}</p>
