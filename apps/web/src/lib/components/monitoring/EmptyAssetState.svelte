<script lang="ts">
  let { message }: { message: string } = $props()
</script>

<div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6">
  <p class="text-slate-600">{message}</p>
</div>
