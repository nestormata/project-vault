<script lang="ts">
  let { hasFilters }: { hasFilters: boolean } = $props()
</script>

<p class="py-6 text-center text-slate-600">
  {hasFilters ? 'No audit events match these filters.' : 'No audit events yet.'}
</p>
