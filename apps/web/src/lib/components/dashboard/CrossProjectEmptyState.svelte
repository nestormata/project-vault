<script lang="ts">
  import { resolve } from '$app/paths'
  import { dashboardEmptyStateCopy } from './dashboard-copy.js'
</script>

<section class="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="space-y-3">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Empty dashboard</p>
    <h1 class="text-3xl font-bold text-slate-950">No projects are saved yet.</h1>
    <p class="text-slate-700">{dashboardEmptyStateCopy.projectModel}</p>
    <p class="text-slate-700">{dashboardEmptyStateCopy.organizingPrinciple}</p>
  </div>
  <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
    <a class="font-semibold text-slate-950 underline" href={resolve('/projects/new')}>
      Create your first project
    </a>
    <p class="mt-2 text-sm text-slate-600">
      Want to explore without saving? The preview flow remains available at
      <a class="underline" href={resolve('/projects/preview')}>/projects/preview</a>.
    </p>
  </div>
</section>
