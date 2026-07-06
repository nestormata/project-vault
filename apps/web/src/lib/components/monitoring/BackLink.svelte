<script lang="ts">
  import { resolve } from '$app/paths'

  let { href, label }: { href: string; label: string } = $props()
</script>

<a class="inline-block font-medium text-slate-700 underline" href={resolve(href)}>
  {label}
</a>
