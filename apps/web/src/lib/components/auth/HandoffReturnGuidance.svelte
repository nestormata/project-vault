<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'

  // Story 60.4: the guidance back to CentralizeMe after a failed handoff. It is an <a> only when
  // `centralizeMeOrigin` is set — resolved server-side from the web process's own
  // VAULT_HANDOFF_ISSUER (origin only, http(s) only), never from this page's query string. Same tab;
  // rel="external" marks it as a full-document navigation off-site (SvelteKit's router skips it),
  // and rel="noreferrer" keeps this page's URL from being
  // sent to CM as a Referer. Both branches render from the same two message keys so the wording
  // cannot drift.
  let { centralizeMeOrigin }: { centralizeMeOrigin: string | null } = $props()
</script>

<p class="text-sm text-slate-600">
  {#if centralizeMeOrigin}<a
      class="font-medium text-brand-600 underline"
      href={centralizeMeOrigin}
      rel="external noopener noreferrer">{m.auth_handoff_return_link_text()}</a
    >{:else}{m.auth_handoff_return_link_text()}{/if}{m.auth_handoff_return_suffix()}
</p>
