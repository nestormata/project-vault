<script lang="ts">
  import FieldSetEditor from '$lib/components/credentials/FieldSetEditor.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { CredentialValueRegionProps } from './credential-value-controller.svelte.js'

  // AC-8: editing the fields of a multi-field secret (a blind overwrite pre-filled from a reveal).
  // Story 69-14: as one replaceable region. The editor's pre-filled values stay in the controller.
  let { controller, pointProps, data }: CredentialValueRegionProps = $props()
</script>

<!-- @region credential.detail.value-edit-fields -->
<RegionFragment>
  <h3 class="font-semibold text-slate-950">Edit fields</h3>
  {#if !controller.editingFieldSet}
    <button
      class="mt-3 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      type="button"
      disabled={controller.loadingFieldSet}
      onclick={() => void controller.startEditFieldSet()}
    >
      {controller.loadingFieldSet ? 'Loading…' : 'Edit fields'}
    </button>
  {:else}
    <form
      method="post"
      class="mt-3 space-y-3"
      onsubmit={(event) => {
        event.preventDefault()
        void controller.saveFieldSet()
      }}
    >
      <FieldSetEditor
        bind:fields={controller.editFields}
        errors={controller.fieldSetErrors}
        onAdd={() => controller.addEditField()}
        onRemove={(index) => controller.removeEditField(index)}
      />
      {#if controller.fieldSetFormError}
        <p class="text-sm text-red-700" role="alert">{controller.fieldSetFormError}</p>
      {/if}
      <div class="flex gap-2">
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={controller.addingVersion || controller.isArchived}
        >
          {controller.addingVersion ? 'Saving…' : 'Save fields'}
        </button>
        <button
          class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
          type="button"
          onclick={() => controller.cancelEditFieldSet()}
        >
          Cancel
        </button>
      </div>
    </form>
  {/if}<InjectionPoint name="credential.detail.value-edit-fields" props={pointProps} {data} />
</RegionFragment>
