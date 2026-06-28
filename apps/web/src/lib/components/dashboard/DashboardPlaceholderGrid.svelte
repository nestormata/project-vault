<script lang="ts">
  import { dashboardEmptyStateCopy } from './dashboard-copy.js'
</script>

<section class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Project coverage gaps">
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Credentials</h2>
    <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCredentials}</p>
    <p class="mt-2 text-sm text-slate-600">
      Credentials will live inside a project with descriptions, tags, expiry dates, and dependent
      systems.
    </p>
  </article>
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Certificates and domains</h2>
    <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCertificates}</p>
  </article>
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Services and health</h2>
    <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noServices}</p>
    <p class="mt-2 text-sm text-slate-600">
      When service monitoring arrives, this area will show availability and incident signals for
      this project.
    </p>
  </article>
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Alerts</h2>
    <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noAlerts}</p>
  </article>
  <article class="rounded-2xl border border-slate-200 bg-white p-4 md:col-span-2">
    <h2 class="font-semibold">Coverage gaps</h2>
    <p class="mt-2 text-sm text-slate-600">
      Project coverage is incomplete because no operational assets have been added yet.
    </p>
    <p class="mt-2 text-sm text-slate-600">
      Story 2.1 starts with saved projects; credential and service coverage follow in later stories.
    </p>
  </article>
</section>
