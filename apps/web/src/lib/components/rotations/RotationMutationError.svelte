<script lang="ts">
  import { resolve } from '$app/paths'

  // Story 69.14: the error banner under the complete, promote and retire buttons, with the systems
  // that still need confirmation and an "Enable MFA" link when the message asks for it.
  let { message, pendingNames }: { message: string; pendingNames: string[] } = $props()
</script>

<div class="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
  <p>
    {message}
    {#if message.includes('MFA')}
      <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
    {/if}
  </p>
  {#if pendingNames.length > 0}
    <ul class="mt-1 list-disc pl-5">
      {#each pendingNames as name (name)}
        <li>{name}</li>
      {/each}
    </ul>
  {/if}
</div>
