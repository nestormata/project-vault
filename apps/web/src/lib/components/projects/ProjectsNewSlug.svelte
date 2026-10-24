<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.12: the slug field of the new project form. The form owns the value, the edited flag
  // and both error sources (a taken slug, a validation detail).
  let {
    slug,
    slugError,
    error,
    onInput,
    data,
  }: {
    slug: string
    slugError: string | null
    error?: string | undefined
    onInput: (value: string) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3}$'
</script>

<!-- @region project.new.slug -->
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
    oninput={(event) => onInput(event.currentTarget.value)}
    aria-describedby="project-slug-help"
  />
  <FormHelpText id="project-slug-help" kind="text" />
  <p class="text-sm text-slate-600">Use 3-50 lowercase letters, numbers, and hyphens.</p>
  {#if slugError}
    <p class="text-sm text-red-700" role="alert">{slugError}</p>
  {:else if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}<InjectionPoint name="project.new.slug" {data} />
</div>
