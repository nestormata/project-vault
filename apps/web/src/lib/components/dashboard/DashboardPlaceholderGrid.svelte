<script lang="ts">
  import { dashboardEmptyStateCopy } from './dashboard-copy.js'

  type CardStatus = 'loading' | 'ready' | 'error'
  type MonitoringCard = { status: CardStatus; count: number }

  const initialCard: MonitoringCard = { status: 'loading', count: 0 }

  let {
    hasCredentials = false,
    hasServices = false,
    certificates = initialCard,
    domains = initialCard,
  }: {
    hasCredentials?: boolean
    hasServices?: boolean
    certificates?: MonitoringCard
    domains?: MonitoringCard
  } = $props()

  function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`
  }
</script>

<section class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Project coverage gaps">
  {#if !hasCredentials}
    <article class="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Credentials</h2>
      <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCredentials}</p>
      <p class="mt-2 text-sm text-slate-600">
        Credentials will live inside a project with descriptions, tags, expiry dates, and dependent
        systems.
      </p>
    </article>
  {/if}
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Certificates and domains</h2>
    {#if certificates.status === 'loading'}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label="Loading certificates"
      >
        Loading certificates
      </p>
    {:else if certificates.status === 'error'}
      <p class="mt-2 text-sm text-amber-700">Certificates unavailable right now.</p>
    {:else}
      <p class="mt-2 text-sm text-slate-600">
        {countLabel(certificates.count, 'certificate', 'certificates')}
      </p>
    {/if}
    {#if domains.status === 'loading'}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label="Loading domains"
      >
        Loading domains
      </p>
    {:else if domains.status === 'error'}
      <p class="mt-2 text-sm text-amber-700">Domains unavailable right now.</p>
    {:else}
      <p class="mt-2 text-sm text-slate-600">{countLabel(domains.count, 'domain', 'domains')}</p>
    {/if}
    {#if certificates.status === 'ready' && domains.status === 'ready' && certificates.count === 0 && domains.count === 0}
      <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCertificates}</p>
    {/if}
  </article>
  {#if !hasServices}
    <article class="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Services and health</h2>
      <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noServices}</p>
      <p class="mt-2 text-sm text-slate-600">
        When service monitoring arrives, this area will show availability and incident signals for
        this project.
      </p>
    </article>
  {/if}
  <article class="rounded-2xl border border-slate-200 bg-white p-4 md:col-span-2">
    <h2 class="font-semibold">Coverage gaps</h2>
    <p class="mt-2 text-sm text-slate-600">
      Live certificate and domain counts are shown above for this project.
    </p>
  </article>
</section>
