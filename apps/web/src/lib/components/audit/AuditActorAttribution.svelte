<script lang="ts">
  import { occurredAtDisplay } from '$lib/audit/attribution.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import type { AuditEventItem } from '$lib/api/audit.js'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.12: what an extension-written row says about who acted and when, inside the actor cell.
  // The point renders once per row, after the attribution (or after the name when there is none).
  let {
    event,
    pointProps,
    data,
  }: {
    event: AuditEventItem
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.results-attribution -->
<RegionFragment>
  {#if event.attribution}
    {@const actor = event.attribution.actor}
    {@const occurred = occurredAtDisplay(event.createdAt, event.attribution)}
    {#if actor?.kind === 'issuer_attested'}
      <!-- Never the actor-name position or typography: provider next to subject, in words. -->
      <span
        data-testid="actor-attestation"
        class="mt-1 block max-w-xs rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs break-all text-slate-800"
      >
        <strong class="font-semibold">{m.audit_attr_badge_issuer()}</strong>
        <span class="block italic"
          >{m.audit_attr_identity({
            provider: actor.provider,
            subject: actor.subject,
          })}</span
        >
        <span class="block"
          >{actor.reason === 'not_current_member'
            ? m.audit_attr_reason_not_member()
            : m.audit_attr_reason_unlinked()}</span
        >
      </span>
    {:else if actor?.kind === 'pv_verified'}
      <span data-testid="actor-delegated" class="mt-1 block text-xs text-slate-500"
        >{m.audit_attr_verified_delegated()}</span
      >
    {/if}
    {#if occurred}
      <span data-testid="actor-occurred" class="mt-1 block text-xs text-slate-500"
        >{occurred.signed
          ? m.audit_attr_occurred_signed({ time: occurred.time })
          : m.audit_attr_occurred_declared({ time: occurred.time })}</span
      >
    {/if}
  {/if}<InjectionPoint name="settings.audit.results-attribution" props={pointProps} {data} />
</RegionFragment>
