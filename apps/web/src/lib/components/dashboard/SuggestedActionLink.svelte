<script lang="ts">
  import { resolve } from '$app/paths'
  import type { ProjectPath } from '$lib/app-paths.js'

  let { path, label }: { path: ProjectPath; label: string } = $props()
</script>

<a class="font-medium text-slate-950 underline" href={resolve(path)}>{label}</a>
