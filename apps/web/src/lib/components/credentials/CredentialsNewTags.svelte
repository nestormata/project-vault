<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.11: the tags field of the new secret form. The form owns the value (bindable).
  let {
    tags = $bindable(),
    data,
  }: {
    tags: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.tags -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="credential-tags">Tags</label>
  <input
    id="credential-tags"
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    type="text"
    placeholder="production, api"
    bind:value={tags}
    aria-describedby="credential-tags-help"
  />
  <FormHelpText id="credential-tags-help" kind="text" /><InjectionPoint
    name="project.credentials-new.tags"
    {data}
  />
</div>
