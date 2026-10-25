<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/credentials/new/$types.js'
  import type { Snippet } from 'svelte'
  import {
    buildTemplateFieldDrafts,
    mapCredentialSubmitError,
    parseTagsInput,
    validateCredentialForm,
    validateFieldSet,
    type FieldDraft,
  } from '$lib/components/onboarding/onboarding-logic.js'
  import { canCreateCredentialInProject } from '$lib/credentials/permissions.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createCredential } from '$lib/api/credentials.js'
  import type { CredentialTemplate } from '@project-vault/shared'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import CredentialsNewDescription from './CredentialsNewDescription.svelte'
  import CredentialsNewError from './CredentialsNewError.svelte'
  import CredentialsNewFields from './CredentialsNewFields.svelte'
  import CredentialsNewName from './CredentialsNewName.svelte'
  import CredentialsNewSubmit from './CredentialsNewSubmit.svelte'
  import CredentialsNewTags from './CredentialsNewTags.svelte'
  import CredentialsNewTemplate from './CredentialsNewTemplate.svelte'
  import CredentialsNewValue from './CredentialsNewValue.svelte'

  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  let name = $state('')
  let value = $state('')
  let description = $state('')
  let tags = $state('')
  // '' = no template selected → single-value form (AC-5). Otherwise a structured field set.
  let template = $state<'' | CredentialTemplate>('')
  let fields = $state<FieldDraft[]>([])
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  let fieldErrors = $state<{ name?: string; value?: string }>({})
  let fieldSetErrors = $state<Record<number, string>>({})
  const canCreate = $derived(canCreateCredentialInProject(pageData.orgRole, pageData.project))
  const useFieldSet = $derived(template !== '')
  function hasFieldEdits(): boolean {
    return fields.some((f) => f.value.trim() !== '')
  }
  function onTemplateChange(next: '' | CredentialTemplate): void {
    // Switching templates is a destructive re-population (AC-1) — confirm before discarding edits.
    if (hasFieldEdits() && !confirm('Switching templates will reset your fields. Continue?')) {
      return
    }
    template = next
    fieldSetErrors = {}
    fields = next === '' ? [] : buildTemplateFieldDrafts(next)
  }
  function addField(): void {
    fields = [...fields, { key: '', value: '', sensitive: false }]
  }
  function removeField(index: number): void {
    fields = fields.filter((_, i) => i !== index)
    fieldSetErrors = {}
  }
  async function submitForm() {
    if (submitting || !canCreate) return
    fieldErrors = validateCredentialForm({ name, value: useFieldSet ? 'x' : value })
    if (fieldErrors.name) return

    if (useFieldSet) {
      const result = validateFieldSet(fields)
      fieldSetErrors = result.fieldErrors
      if (!result.ok) {
        errorMessage = result.formError ?? null
        return
      }
    } else if (fieldErrors.value) {
      return
    }

    submitting = true
    errorMessage = null
    try {
      const tagList = parseTagsInput(tags)
      const common = {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        tags: tagList.length > 0 ? tagList : undefined,
      }
      const body = useFieldSet
        ? {
            ...common,
            template: template as CredentialTemplate,
            fields: fields.map((f) => ({
              key: f.key.trim(),
              value: f.value,
              sensitive: f.sensitive,
            })),
          }
        : { ...common, value }
      const created = await createCredential(fetch, pageData.projectId, body)
      value = ''
      await goto(resolve(`/projects/${pageData.projectId}/credentials/${created.id}`))
    } catch (error) {
      value = ''
      const mapped = mapCredentialSubmitError(error)
      fieldErrors = mapped.fieldErrors
      errorMessage = mapped.errorMessage
      if (mapped.fieldKeyConflict) {
        // AC-3 — attach an inline error to the field whose key collides.
        const idx = fields.findIndex(
          (f) => f.key.trim().toLowerCase() === mapped.fieldKeyConflict?.toLowerCase()
        )
        if (idx >= 0) fieldSetErrors = { ...fieldSetErrors, [idx]: mapped.errorMessage }
      }
    } finally {
      submitting = false
    }
  }
</script>

{@render children?.()}
{#if !canCreate}
  <AccessNotice
    title="Create not available"
    message="Secret creation requires Member access or higher. Ask your administrator to upgrade your role."
    backHref={`/projects/${pageData.projectId}/credentials`}
    backLabel="Back to secrets"
  />
{:else}
  <form
    method="post"
    class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    onsubmit={(event) => {
      event.preventDefault()
      void submitForm()
    }}
  >
    <CredentialsNewName bind:name error={fieldErrors.name} {data} />

    <CredentialsNewTemplate {template} onChange={onTemplateChange} {data} />

    {#if !useFieldSet}
      <CredentialsNewValue bind:value error={fieldErrors.value} {data} />
    {:else}
      <CredentialsNewFields
        bind:fields
        errors={fieldSetErrors}
        multilineValue={template === 'secure_note'}
        onAdd={addField}
        onRemove={removeField}
        {data}
      />
    {/if}

    <CredentialsNewDescription bind:description {data} />

    <CredentialsNewTags bind:tags {data} />

    <CredentialsNewError {errorMessage} {data} />

    <CredentialsNewSubmit projectId={pageData.projectId} {submitting} {data} />
  </form>
{/if}
