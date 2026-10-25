<script lang="ts">
  import type { ProjectListPage } from '$lib/api/projects.js'

  // The secrets / expiring / alerts counts shown on every project card.
  let { project }: { project: ProjectListPage['items'][number] } = $props()
</script>

<dl class="mt-4 grid grid-cols-3 gap-2 text-sm">
  <div>
    <dt class="text-slate-500">Secrets</dt>
    <dd class="font-semibold">{project.credentialCount}</dd>
  </div>
  <div>
    <dt class="text-slate-500">Expiring</dt>
    <dd class="font-semibold">{project.expiringCount}</dd>
  </div>
  <div>
    <dt class="text-slate-500">Alerts</dt>
    <dd class="font-semibold">{project.alertCount}</dd>
  </div>
</dl>
