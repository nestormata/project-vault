<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { downloadExportBlob, exportProject } from '$lib/api/project-export.js'
  import { ApiClientError } from '$lib/api/client.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import * as m from '$lib/paraglide/messages.js'

  // Story 69.12: the part of the export section that runs the export and owns the reveal-once
  // state (Story 28.9 D2): the export key is shown exactly once, mirroring the credential-share
  // creation flow's "copy it now, it will not be shown again" convention. Story 62-2 D3: the key,
  // `exporting` and the copy status never leave this component (not as props, snippet arguments,
  // context or bindings), and a contribution at `project.detail.export-key` receives `{ project }`
  // ONLY. The panel above learns two things through bindings: whether a reveal is open (`revealed`,
  // a boolean) and the failure message (`exportError`, an API error message), so it can hide the
  // description and show the error in their own sub-regions. The point sits outside the
  // `{#if revealedExportKey}` branch so it does not depend on the key state.
  let {
    project,
    revealed = $bindable(),
    exportError = $bindable(),
    data,
  }: {
    project: ProjectOverview
    revealed: boolean
    exportError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let exporting = $state(false)
  let revealedExportKey = $state<string | null>(null)
  let exportKeyAcknowledged = $state(false)

  async function onExportProject(projectId: string): Promise<void> {
    if (exporting) return
    exporting = true
    exportError = null
    try {
      const result = await exportProject(fetch, projectId)
      downloadExportBlob(result.blob, result.filename)
      clearCopyStatus()
      revealedExportKey = result.exportKey
      revealed = Boolean(result.exportKey)
      exportKeyAcknowledged = false
    } catch (error) {
      exportError =
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Export failed.'
    } finally {
      exporting = false
    }
  }

  // Story 62-2 AC-1 (D1): the copy-with-confirmation pattern of `CredentialValueSection`, kept
  // inside this component so the key never reaches a child, context or the injection point (D3).
  // One status message at a time: a new copy replaces the previous message and restarts the timer.
  const COPY_STATUS_MS = 3000
  let copyStatus = $state('')
  let copyStatusTimeout: ReturnType<typeof setTimeout> | undefined

  function clearCopyStatus(): void {
    clearTimeout(copyStatusTimeout)
    copyStatusTimeout = undefined
    copyStatus = ''
  }

  function showCopyStatus(message: string): void {
    clearTimeout(copyStatusTimeout)
    copyStatus = message
    copyStatusTimeout = setTimeout(clearCopyStatus, COPY_STATUS_MS)
  }

  async function copyExportKey(): Promise<void> {
    if (!revealedExportKey) return
    try {
      await navigator.clipboard.writeText(revealedExportKey)
      showCopyStatus(m.project_export_copy_success())
    } catch {
      // Never surface the underlying error: it could echo the clipboard payload (the key).
      showCopyStatus(m.project_export_copy_failure())
    }
  }

  // No state update after unmount: the pending timeout dies with the component.
  $effect(() => clearCopyStatus)

  function dismissExportKey(): void {
    if (!exportKeyAcknowledged) return
    clearCopyStatus()
    revealedExportKey = null
    revealed = false
  }
</script>

<!-- @region project.detail.export-key -->
<RegionFragment>
  {#if revealedExportKey}
    <div class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      <p class="font-semibold text-amber-900">
        Your export key — copy it now, it will not be shown again.
      </p>
      <div class="mt-2 flex items-start gap-2">
        <code
          class="block min-w-0 flex-1 break-all rounded-lg bg-white px-3 py-2 text-xs text-slate-900"
        >
          {revealedExportKey}
        </code>
        <button
          type="button"
          class="shrink-0 rounded-lg border border-amber-900 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900"
          onclick={() => void copyExportKey()}
        >
          {m.project_export_copy_label()}
        </button>
      </div>
      <!-- Rendered empty while the reveal is open so assistive tech registers the live region
           before the first message is injected into it. -->
      <p role="status" aria-live="polite" class="mt-1 min-h-4 text-xs font-medium text-amber-900">
        {copyStatus}
      </p>
      <label class="mt-3 flex items-center gap-2 text-xs text-amber-900">
        <input
          type="checkbox"
          bind:checked={exportKeyAcknowledged}
          aria-describedby="export-key-ack-help"
        />
        I have saved this key — it cannot be retrieved again.
      </label>
      <FormHelpText
        id="export-key-ack-help"
        kind="checkbox"
        text="Confirms you copied the export key shown above. The server never stores it, so once you leave this page without saving it, the export file can never be decrypted again."
      />
      <button
        type="button"
        class="mt-3 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!exportKeyAcknowledged}
        onclick={dismissExportKey}
      >
        Done
      </button>
    </div>
  {:else}
    <button
      type="button"
      class="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      disabled={exporting}
      onclick={() => void onExportProject(project.id)}
    >
      {exporting ? 'Exporting…' : 'Export project'}
    </button>
  {/if}<InjectionPoint name="project.detail.export-key" props={{ project }} {data} />
</RegionFragment>
