<!--
  @pv-stable: the props contract ({ id, label, hint, helpId, error, children }) is final (Story
  72.3). A labelled form field: the label, the control (the `children` snippet receives the ids to
  wire) and the hint and error text. `id` is required and explicit, so the server and the browser
  can never disagree on it. The help id is `<id>-help` unless `helpId` says otherwise; the error id
  is always `<id>-error`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import FieldMessages from './FieldMessages.svelte'
  import { describedByOf } from './field-ids.js'

  export interface FieldWiring {
    /** The control's `aria-describedby`: error first, then hint; undefined when neither shows. */
    describedBy: string | undefined
    /** `true` while an error shows, else undefined (so no attribute is rendered). */
    invalid: true | undefined
  }

  let {
    id,
    label,
    hint,
    helpId,
    error,
    children,
  }: {
    id: string
    label: string
    hint?: string
    helpId?: string
    error?: string
    children: Snippet<[FieldWiring]>
  } = $props()

  const wiring = $derived<FieldWiring>({
    describedBy: describedByOf(id, helpId, hint, error),
    invalid: error ? true : undefined,
  })
</script>

<div class="space-y-2">
  <label class="block font-medium text-slate-900" for={id}>{label}</label>
  {@render children(wiring)}
  <FieldMessages {id} {hint} {helpId} {error} />
</div>
