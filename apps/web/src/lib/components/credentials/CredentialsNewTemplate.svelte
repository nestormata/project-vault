<script lang="ts">
  import {
    CREDENTIAL_TEMPLATES,
    CREDENTIAL_TEMPLATE_LABELS,
    type CredentialTemplate,
  } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the template select of the new secret form. The form owns the chosen template and
  // confirms before a switch discards edited fields (`onChange`).
  let {
    template,
    onChange,
    data,
  }: {
    template: '' | CredentialTemplate
    onChange: (next: '' | CredentialTemplate) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.template -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-template">Template</label>
  <select
    id="credential-template"
    class="w-full rounded-xl border border-slate-300 px-3 py-3"
    value={template}
    aria-describedby="credential-template-help"
    onchange={(event) => {
      const select = event.currentTarget
      onChange(select.value as '' | CredentialTemplate)
      select.value = template
    }}
  >
    <option value="">No template — single value</option>
    {#each CREDENTIAL_TEMPLATES as tpl (tpl)}
      <option value={tpl}>{CREDENTIAL_TEMPLATE_LABELS[tpl]}</option>
    {/each}
  </select>
  <FormHelpText id="credential-template-help" kind="select" /><InjectionPoint
    name="project.credentials-new.template"
    {data}
  />
</div>
