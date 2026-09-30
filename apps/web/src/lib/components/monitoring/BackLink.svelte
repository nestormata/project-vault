<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ProjectPath } from '$lib/app-paths.js'

  let { href, label }: { href: ProjectPath; label: string } = $props()
</script>

<a class="inline-block font-medium text-slate-700 underline" href={resolve(href)}>
  {label}
</a>
