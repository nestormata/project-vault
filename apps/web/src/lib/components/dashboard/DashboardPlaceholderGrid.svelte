<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { getDashboardEmptyStateCopy } from './dashboard-copy.js'

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

  // Story 28.4 Dev Notes "Pluralization approach": no ICU/CLDR plural-selector machinery exists
  // in this codebase — two translated message keys per countable noun (singular/plural), selected
  // by the existing count === 1 ? singular : plural branching, matching current sophistication.
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
      <h2 class="font-semibold">{m.dashboard_secrets_label()}</h2>
      <p class="mt-2 text-sm text-slate-600">{getDashboardEmptyStateCopy().noCredentials}</p>
      <p class="mt-2 text-sm text-slate-600">
        {m.dashboard_placeholder_secrets_description()}
      </p>
    </article>
  {/if}
  <article class="rounded-2xl border border-slate-200 bg-white p-4">
    <h2 class="font-semibold">{m.dashboard_placeholder_certs_heading()}</h2>
    {#await certificates}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label={m.dashboard_placeholder_loading_certificates()}
      >
        {m.dashboard_placeholder_loading_certificates()}
      </p>
    {:then certificateState}
      {#if certificateState.status === 'loading'}
        <p
          class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
          aria-label={m.dashboard_placeholder_loading_certificates()}
        >
          {m.dashboard_placeholder_loading_certificates()}
        </p>
      {:else if certificateState.status === 'error'}
        <p class="mt-2 text-sm text-amber-700">{m.dashboard_placeholder_certs_unavailable()}</p>
      {:else}
        <p class="mt-2 text-sm text-slate-600">
          {countLabel(
            certificateState.count,
            m.dashboard_certificate_singular(),
            m.dashboard_certificate_plural()
          )}
        </p>
      {/if}
    {:catch}
      <p class="mt-2 text-sm text-amber-700">{m.dashboard_placeholder_certs_unavailable()}</p>
    {/await}
    {#await domains}
      <p
        class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
        aria-label={m.dashboard_placeholder_loading_domains()}
      >
        {m.dashboard_placeholder_loading_domains()}
      </p>
    {:then domainState}
      {#if domainState.status === 'loading'}
        <p
          class="mt-2 h-5 animate-pulse rounded bg-slate-100 text-sm text-transparent"
          aria-label={m.dashboard_placeholder_loading_domains()}
        >
          {m.dashboard_placeholder_loading_domains()}
        </p>
      {:else if domainState.status === 'error'}
        <p class="mt-2 text-sm text-amber-700">{m.dashboard_placeholder_domains_unavailable()}</p>
      {:else}
        <p class="mt-2 text-sm text-slate-600">
          {countLabel(
            domainState.count,
            m.dashboard_domain_singular(),
            m.dashboard_domain_plural()
          )}
        </p>
      {/if}
    {:catch}
      <p class="mt-2 text-sm text-amber-700">{m.dashboard_placeholder_domains_unavailable()}</p>
    {/await}
    {#if !isPromiseLike(certificates) && !isPromiseLike(domains) && certificates.status === 'ready' && domains.status === 'ready' && certificates.count === 0 && domains.count === 0}
      <p class="mt-2 text-sm text-slate-600">{getDashboardEmptyStateCopy().noCertificates}</p>
    {/if}
    {#await Promise.all([certificates, domains]) then states}
      {#if (isPromiseLike(certificates) || isPromiseLike(domains)) && states[0].status === 'ready' && states[1].status === 'ready' && states[0].count === 0 && states[1].count === 0}
        <p class="mt-2 text-sm text-slate-600">{getDashboardEmptyStateCopy().noCertificates}</p>
      {/if}
    {/await}
  </article>
  {#if !hasServices}
    <article class="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 class="font-semibold">{m.dashboard_placeholder_services_heading()}</h2>
      <p class="mt-2 text-sm text-slate-600">{getDashboardEmptyStateCopy().noServices}</p>
      <p class="mt-2 text-sm text-slate-600">
        {m.dashboard_placeholder_services_description()}
      </p>
    </article>
  {/if}
  <article class="rounded-2xl border border-slate-200 bg-white p-4 md:col-span-2">
    <h2 class="font-semibold">{m.dashboard_placeholder_coverage_gaps_heading()}</h2>
    <p class="mt-2 text-sm text-slate-600">
      {m.dashboard_placeholder_coverage_gaps_description()}
    </p>
  </article>
</section>
