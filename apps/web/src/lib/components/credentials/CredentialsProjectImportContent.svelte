<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/credentials/import/$types.js'
  import type { Snippet } from 'svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import CredentialsImportBack from './CredentialsImportBack.svelte'
  import CredentialsImportDone from './CredentialsImportDone.svelte'
  import CredentialsImportError from './CredentialsImportError.svelte'
  import CredentialsImportPreviewActions from './CredentialsImportPreviewActions.svelte'
  import CredentialsImportPreviewTable from './CredentialsImportPreviewTable.svelte'
  import CredentialsImportUpload from './CredentialsImportUpload.svelte'
  import { CredentialsImportFlow } from './credentials-import-flow.svelte.js'

  // Story 69.11: the import page body follows one step at a time (upload, preview, done), each a
  // sub-region, then the error banner and the back link. `CredentialsImportFlow` is the one owner
  // of the flow state. The page's loaded data stays `pageData`; `data` is its `__inject` map.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const flow = new CredentialsImportFlow(() => pageData)
</script>

{@render children?.()}
{#if !pageData.canImport}
  <AccessNotice
    title="Import not available"
    message="Bulk import requires Admin or Owner access. Ask your administrator to upgrade your role."
    backHref={`/projects/${pageData.projectId}/credentials`}
    backLabel="Back to secrets"
  />
{:else if flow.step === 'done' && flow.summary}
  <CredentialsImportDone summary={flow.summary} projectId={pageData.projectId} {data} />
{:else if flow.step === 'preview' && flow.preview}
  <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Preview ({flow.preview.itemCount} items)</h2>
    <CredentialsImportPreviewTable parsed={flow.preview.parsed} {data} />
    <CredentialsImportPreviewActions {flow} {data} />
  </div>
{:else}
  <CredentialsImportUpload {flow} {data} />
{/if}

<CredentialsImportError errorMessage={flow.errorMessage} {data} />

{#if pageData.canImport && flow.step !== 'done'}
  <CredentialsImportBack projectId={pageData.projectId} {data} />
{/if}
