<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import * as m from '$lib/paraglide/messages.js'
  import type { ProjectImportFlow } from './project-import-flow.svelte.js'

  // Story 69.11: the export key field of the project import form (hardened against autofill and
  // password managers, with a show/hide toggle). The key is never handed to a point.
  let {
    flow,
    data,
  }: {
    flow: ProjectImportFlow
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.import.export-key -->
<div>
  <label class="block text-sm font-medium text-slate-800" for="export-key">Export key</label>
  <div class="mt-1 flex items-center gap-2">
    <input
      id="export-key"
      type={flow.showExportKey ? 'text' : 'password'}
      class="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      bind:value={flow.exportKey}
      bind:this={flow.exportKeyInput}
      placeholder="The one-time key shown when this file was exported"
      required
      autocomplete="off"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      data-1p-ignore
      data-lpignore="true"
      aria-describedby="export-key-help"
    />
    <button
      type="button"
      class="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800"
      aria-pressed={flow.showExportKey}
      aria-controls="export-key"
      onclick={() => flow.toggleExportKeyVisibility()}
    >
      {flow.showExportKey ? m.project_import_export_key_hide() : m.project_import_export_key_show()}
    </button>
  </div>
  <FormHelpText
    id="export-key-help"
    kind="secret"
    text="The one-time decryption key you were shown when this export was created. It was never stored on the server, so it can't be recovered here — you must have saved it yourself."
  /><InjectionPoint name="project.import.export-key" {data} />
</div>
