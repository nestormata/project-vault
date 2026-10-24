<script lang="ts">
  import type { PageData } from '../../../routes/(app)/settings/users/[userId]/erasure/[requestId]/$types.js'
  import type { Snippet } from 'svelte'
  import ErasureExecute from './ErasureExecute.svelte'
  import ErasureInventory from './ErasureInventory.svelte'
  import ErasureNotice from './ErasureNotice.svelte'
  import ErasureReport from './ErasureReport.svelte'

  // Story 69.11: the erasure request page body is one sub-region per state (a notice, the pending
  // card with its PII inventory and execute zone, the compliance report). The page's loaded data
  // stays `pageData`; `data` is the page's `__inject` map.
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
{#if pageData.state === 'pending'}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <ErasureInventory piiInventory={pageData.piiInventory} {data} />

    <ErasureExecute
      orgRole={pageData.orgRole}
      userId={pageData.userId}
      requestId={pageData.requestId}
      userEmail={pageData.userEmail}
      {data}
    />
  </div>
{:else if pageData.state === 'completed'}
  <ErasureReport requestId={pageData.requestId} report={pageData.report} {data} />
{:else}
  <ErasureNotice state={pageData.state} {data} />
{/if}
