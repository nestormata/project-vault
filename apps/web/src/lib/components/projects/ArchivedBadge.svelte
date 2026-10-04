<script lang="ts">
  let { testid }: { testid?: string } = $props()
</script>

<span
  class="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-700"
  data-testid={testid}
>
  Archived
</span>
