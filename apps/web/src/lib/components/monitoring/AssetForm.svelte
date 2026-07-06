<!--
  The card-styled <form> shell shared by every monitored-asset create/edit form: it just wires up
  preventDefault + the submit handler and renders whatever fields the caller passes as children.
-->
<script lang="ts">
  let {
    onsubmit,
    children,
  }: {
    onsubmit: () => void
    children: import('svelte').Snippet
  } = $props()
</script>

<form
  class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
  onsubmit={(event) => {
    event.preventDefault()
    onsubmit()
  }}
>
  {@render children()}
</form>
