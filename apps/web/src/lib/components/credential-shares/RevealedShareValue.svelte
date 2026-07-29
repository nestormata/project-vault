<script lang="ts">
  // Shared by both reveal pages — the revealed-value display is identical regardless of
  // recipient type.
  let { value }: { value: string } = $props()
</script>

<div class="mt-4">
  <p class="mb-1 text-sm font-medium text-slate-700">Value</p>
  <code class="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-900">
    {value}
  </code>
</div>
