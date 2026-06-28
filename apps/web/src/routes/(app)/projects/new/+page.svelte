<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import { createProject, suggestProjectSlug } from '$lib/api/projects.js'

  const SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3}$'

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

<svelte:head>
  <title>Create Project | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">New project</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Create a project</h1>
    <p class="mt-2 text-slate-600">
      Projects group secrets, services, certificates, and future rotation work by team or domain.
    </p>
  </div>

  <form
    class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    onsubmit={(event) => {
      event.preventDefault()
      void submitForm()
    }}
  >
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="project-name">Name</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-3"
        id="project-name"
        type="text"
        value={name}
        maxlength="128"
        required
        oninput={(event) => updateName(event.currentTarget.value)}
      />
      {#if fieldErrors.name}
        <p class="text-sm text-red-700">{fieldErrors.name[0]}</p>
      {/if}
    </div>

    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="project-slug">Slug</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-3"
        id="project-slug"
        type="text"
        value={slug}
        minlength="3"
        maxlength="50"
        pattern={SLUG_PATTERN}
        required
        oninput={(event) => updateSlug(event.currentTarget.value)}
      />
      <p class="text-sm text-slate-600">Use 3-50 lowercase letters, numbers, and hyphens.</p>
      {#if slugError}
        <p class="text-sm text-red-700" role="alert">{slugError}</p>
      {:else if fieldErrors.slug}
        <p class="text-sm text-red-700">{fieldErrors.slug[0]}</p>
      {/if}
    </div>

    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="project-description">Description</label>
      <textarea
        class="min-h-28 w-full rounded-xl border border-slate-300 px-3 py-3"
        id="project-description"
        bind:value={description}
        maxlength="512"></textarea>
      {#if fieldErrors.description}
        <p class="text-sm text-red-700">{fieldErrors.description[0]}</p>
      {/if}
    </div>

    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <button
        class="rounded-xl bg-slate-950 px-4 py-3 font-semibold text-white disabled:opacity-60"
        type="submit"
        disabled={submitting}
      >
        {submitting ? 'Creating...' : 'Create project'}
      </button>
      <a class="text-center font-medium text-slate-700 underline" href={resolve('/projects')}
        >Cancel</a
      >
    </div>
  </form>
</section>
