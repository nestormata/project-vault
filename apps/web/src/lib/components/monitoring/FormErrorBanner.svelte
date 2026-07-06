<!--
  The red inline-alert banner used for both submit-time errorMessage (on create/edit forms) and
  deleteError (on list/detail pages) across every monitored-asset page. Renders nothing when
  `message` is falsy.
-->
<script lang="ts">
  let { message }: { message: string | null } = $props()
</script>

{#if message}
  <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    {message}
  </p>
{/if}
