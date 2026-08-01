<script lang="ts">
  import * as m from '$lib/paraglide/messages.js'

  let {
    id,
    text,
    kind = 'text',
  }: {
    id: string
    text?: string
    kind?: 'text' | 'select' | 'checkbox' | 'radio' | 'secret' | 'date' | 'search'
  } = $props()

  const localizedText = $derived(
    text ??
      (
        {
          text: m.form_help_text,
          select: m.form_help_select,
          checkbox: m.form_help_checkbox,
          radio: m.form_help_radio,
          secret: m.form_help_secret,
          date: m.form_help_date,
          search: m.form_help_search,
        }[kind] as () => string
      )()
  )
</script>

<p {id} class="text-sm text-slate-600">{localizedText}</p>
