<script lang="ts">
  import { resolve } from '$app/paths'
  import type { AttentionItem } from '@project-vault/shared'
  import type { DashboardAttentionState } from '$lib/api/dashboard.js'
  import type { ProjectPath } from '$lib/app-paths.js'
  import { formatDate } from '$lib/datetime.js'
  import { m } from '$lib/paraglide/messages.js'

  // Story 72-12: the "Needs attention" list inside the org summary region. It renders nothing at
  // all (no wrapper, no heading) when the read failed or there is nothing to show, so the dashboard
  // markup is unchanged for an organization with no attention items.
  let { attention }: { attention?: DashboardAttentionState } = $props()

  const items = $derived(attention?.status === 'ready' ? attention.items : [])
  const hiddenCount = $derived(
    attention?.status === 'ready'
      ? attention.counts.expiringShares +
          attention.counts.expiringCertificates +
          attention.counts.pendingInvitations -
          attention.items.length
      : 0
  )

  function kindLabel(item: AttentionItem): string {
    if (item.kind === 'expiring_share') return m.dashboard_attention_kind_share()
    if (item.kind === 'expiring_certificate') return m.dashboard_attention_kind_certificate()
    return m.dashboard_attention_kind_invitation()
  }

  function sentence(item: AttentionItem): string {
    const project = item.projectName
    if (item.kind === 'expiring_share') {
      return item.recipientEmail
        ? m.dashboard_attention_share_to_recipient({
            credential: item.credentialName,
            recipient: item.recipientEmail,
            project,
          })
        : m.dashboard_attention_share_anonymous({ credential: item.credentialName, project })
    }
    if (item.kind === 'expiring_certificate') {
      return item.expired
        ? m.dashboard_attention_certificate_expired({ domain: item.domain, project })
        : m.dashboard_attention_certificate_expiring({ domain: item.domain, project })
    }
    return m.dashboard_attention_invitation_pending({ email: item.email, project })
  }

  function linkLabel(item: AttentionItem): string {
    if (item.kind === 'expiring_share') return m.dashboard_attention_link_share()
    if (item.kind === 'expiring_certificate') return m.dashboard_attention_link_certificate()
    return m.dashboard_attention_link_invitation()
  }

  function path(item: AttentionItem): ProjectPath {
    const base = `/projects/${item.projectId}` as const
    if (item.kind === 'expiring_share') return `${base}/credentials/${item.credentialId}`
    if (item.kind === 'expiring_certificate') return `${base}/certificates`
    return `${base}/members`
  }
</script>

{#if items.length > 0}
  <div class="mt-5" data-testid="dashboard-attention">
    <h3 id="dashboard-attention-heading" class="font-semibold text-slate-950">
      {m.dashboard_attention_heading()}
    </h3>
    <ul class="mt-3 space-y-2" aria-labelledby="dashboard-attention-heading">
      {#each items as item (item.id)}
        <li
          class="flex flex-col gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <span class="flex flex-wrap gap-1">
              <span
                class="w-fit rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700"
                >{kindLabel(item)}</span
              >
              {#if item.kind === 'expiring_certificate' && item.expired}
                <span
                  class="w-fit rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
                  >{m.dashboard_attention_expired_flag()}</span
                >
              {/if}
            </span>
            <span class="min-w-0 break-words text-slate-900">{sentence(item)}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span class="text-slate-600"
              >{m.dashboard_expires_label({ date: formatDate(item.dueAt) })}</span
            >
            <a class="font-semibold text-slate-950 underline" href={resolve(path(item))}
              >{linkLabel(item)}</a
            >
          </div>
        </li>
      {/each}
    </ul>
    {#if hiddenCount > 0}
      <p class="mt-2 text-sm text-slate-600">
        {m.dashboard_attention_more({ count: hiddenCount })}
      </p>
    {/if}
  </div>
{/if}
