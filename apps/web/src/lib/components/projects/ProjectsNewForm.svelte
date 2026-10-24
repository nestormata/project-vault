<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createProject, suggestProjectSlug } from '$lib/api/projects.js'
  import ProjectsNewDescription from './ProjectsNewDescription.svelte'
  import ProjectsNewError from './ProjectsNewError.svelte'
  import ProjectsNewName from './ProjectsNewName.svelte'
  import ProjectsNewSlug from './ProjectsNewSlug.svelte'
  import ProjectsNewSubmit from './ProjectsNewSubmit.svelte'

  // Story 69.12: the form owns every typed value and the submit; each field group is a sub-region.
  // `data` is the page's `__inject` map.
  let {
    data,
    children,
  }: { data?: Record<string, readonly unknown[]> | undefined; children?: Snippet } = $props()

  let name = $state('')
  let slug = $state('')
  let description = $state('')
  let slugEdited = $state(false)
  let errorMessage = $state<string | null>(null)
  let slugError = $state<string | null>(null)
  let fieldErrors = $state<Record<string, string[]>>({})
  let submitting = $state(false)
  function updateName(value: string) {
    name = value
    if (!slugEdited) slug = suggestProjectSlug(value)
  }
  function updateSlug(value: string) {
    slugEdited = true
    slug = value
    slugError = null
  }
  function applyValidationDetails(details: unknown) {
    fieldErrors =
      details && typeof details === 'object' ? (details as Record<string, string[]>) : {}
  }
  async function submitForm() {
    if (submitting) return
    errorMessage = null
    slugError = null
    fieldErrors = {}
    submitting = true
    try {
      await createProject(fetch, {
        name,
        slug,
        description: description.trim() ? description.trim() : null,
      })
      await goto(resolve('/dashboard'))
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'slug_taken') {
        slugError = 'A project with this slug already exists - try another.'
      } else if (error instanceof ApiClientError && error.code === 'validation_error') {
        applyValidationDetails(error.details)
        errorMessage = error.message
      } else {
        errorMessage = error instanceof Error ? error.message : 'Project creation failed.'
      }
    } finally {
      submitting = false
    }
  }
</script>

{@render children?.()}
<form
  class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
  onsubmit={(event) => {
    event.preventDefault()
    void submitForm()
  }}
>
  <ProjectsNewName {name} error={fieldErrors.name?.[0]} onInput={updateName} {data} />

  <ProjectsNewSlug {slug} {slugError} error={fieldErrors.slug?.[0]} onInput={updateSlug} {data} />

  <ProjectsNewDescription bind:description error={fieldErrors.description?.[0]} {data} />

  <ProjectsNewError {errorMessage} {data} />

  <ProjectsNewSubmit {submitting} {data} />
</form>
