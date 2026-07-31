<script lang="ts">
  let { id, text }: { id: string; text: string } = $props()
</script>

<p {id} class="text-sm text-slate-600">{text}</p>
