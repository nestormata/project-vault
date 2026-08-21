<script lang="ts">
  import { dashboardEmptyStateCopy } from './dashboard-copy.js'

  type CardStatus = 'loading' | 'ready' | 'error'
  type MonitoringCard = { status: CardStatus; count: number }
  type MonitoringCardInput = MonitoringCard | PromiseLike<MonitoringCard>

  const initialCard: MonitoringCard = { status: 'loading', count: 0 }

  let {
    hasCredentials = false,
    hasServices = false,
    certificates = initialCard,
    domains = initialCard,
  }: {
    hasCredentials?: boolean
    hasServices?: boolean
    certificates?: MonitoringCardInput
    domains?: MonitoringCardInput
  } = $props()

  function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`
  }

  function isPromiseLike(value: MonitoringCardInput): value is PromiseLike<MonitoringCard> {
    return typeof value === 'object' && value !== null && 'then' in value
  }
</script>

<section class="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Project coverage gaps">
  {#if !hasCredentials}
    <article class="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">Secrets</h2>
      <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCredentials}</p>
      <p class="mt-2 text-sm text-slate-600">
        Secrets will live inside a project with descriptions, tags, expiry dates, and dependent
        systems.
      </p>
    </article>
  {/if}
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">Certificates and domains</h2>
    {#await certificates}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label="Loading certificates"
      >
        Loading certificates
      </p>
    {:then certificateState}
      {#if certificateState.status === 'loading'}
        <p
          class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
          aria-label="Loading certificates"
        >
          Loading certificates
        </p>
      {:else if certificateState.status === 'error'}
        <p class="mt-2 text-sm text-amber-700">Certificates unavailable right now.</p>
      {:else}
        <p class="mt-2 text-sm text-slate-600">
          {countLabel(certificateState.count, 'certificate', 'certificates')}
        </p>
      {/if}
    {:catch}
      <p class="mt-2 text-sm text-amber-700">Certificates unavailable right now.</p>
    {/await}
    {#await domains}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label="Loading domains"
      >
        Loading domains
      </p>
    {:then domainState}
      {#if domainState.status === 'loading'}
        <p
          class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
          aria-label="Loading domains"
        >
          Loading domains
        </p>
      {:else if domainState.status === 'error'}
        <p class="mt-2 text-sm text-amber-700">Domains unavailable right now.</p>
      {:else}
        <p class="mt-2 text-sm text-slate-600">
          {countLabel(domainState.count, 'domain', 'domains')}
        </p>
      {/if}
    {:catch}
      <p class="mt-2 text-sm text-amber-700">Domains unavailable right now.</p>
    {/await}
    {#if !isPromiseLike(certificates) && !isPromiseLike(domains) && certificates.status === 'ready' && domains.status === 'ready' && certificates.count === 0 && domains.count === 0}
      <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCertificates}</p>
    {/if}
    {#await Promise.all([certificates, domains]) then states}
      {#if (isPromiseLike(certificates) || isPromiseLike(domains)) && states[0].status === 'ready' && states[1].status === 'ready' && states[0].count === 0 && states[1].count === 0}
        <p class="mt-2 text-sm text-slate-600">{dashboardEmptyStateCopy.noCertificates}</p>
      {/if}
    {/await}
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
