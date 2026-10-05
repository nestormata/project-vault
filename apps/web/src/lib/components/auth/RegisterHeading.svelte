<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'

  let { invitationToken, children }: { invitationToken: string | undefined; children?: Snippet } =
    $props()
</script>

<div class="space-y-2">
  <h1 class="text-3xl font-bold">{m.auth_register_page_heading()}</h1>
  <p class="text-slate-600">
    {invitationToken
      ? m.auth_register_invitation_description()
      : m.auth_register_organization_description()}
  </p>
</div>
{@render children?.()}
