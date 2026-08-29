<script lang="ts">
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
  import { getDashboardEmptyStateCopy } from './dashboard-copy.js'
</script>

<section class="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <div class="space-y-3">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
      {m.dashboard_empty_state_label()}
    </p>
    <h1 class="text-3xl font-bold text-slate-950">{m.dashboard_empty_state_heading()}</h1>
    <p class="text-slate-700">{getDashboardEmptyStateCopy().projectModel}</p>
    <p class="text-slate-700">{getDashboardEmptyStateCopy().organizingPrinciple}</p>
  </div>
  <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
    <a class="font-semibold text-slate-950 underline" href={resolve('/projects/new')}>
      {m.dashboard_empty_state_create_project()}
    </a>
    <p class="mt-2 text-sm text-slate-600">
      {m.dashboard_empty_state_preview_text()}
      <a class="underline" href={resolve('/projects/preview')}>/projects/preview</a>.
    </p>
  </div>
</section>
