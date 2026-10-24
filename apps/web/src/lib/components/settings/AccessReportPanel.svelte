<script lang="ts">
  import type { PageData } from '../../../routes/(app)/settings/audit/access-report/$types.js'
  import type { Snippet } from 'svelte'
  import AccessReportError from './AccessReportError.svelte'
  import AccessReportForm from './AccessReportForm.svelte'
  import AccessReportResults from './AccessReportResults.svelte'
  import AccessReportSummary from './AccessReportSummary.svelte'

  // Story 69.11: the access report page body is the as-of form, the load error, and (once a report
  // exists) a card with its summary row and results, each a sub-region. The page's loaded data stays
  // `pageData`; `data` is the page's `__inject` map.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if !pageData.allowed}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
    <p class="text-slate-600">This page requires the owner role.</p>
  </div>
{:else}
  <AccessReportForm asOf={pageData.asOf} {data} />

  <AccessReportError errorMessage={pageData.errorMessage} {data} />

  {#if pageData.report}
    <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <AccessReportSummary
        report={pageData.report}
        asOf={pageData.asOf}
        page={pageData.page}
        {data}
      />

      <AccessReportResults
        report={pageData.report}
        asOf={pageData.asOf}
        page={pageData.page}
        {data}
      />
    </div>
  {/if}
{/if}
