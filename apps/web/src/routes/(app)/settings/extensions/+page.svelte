<script lang="ts">
  import { resolve } from '$app/paths'

  let { data } = $props()

  function formatLoadedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }

  // Story 23.3 AC-9/AC-33: the page has NO liveness data — it can read exactly one thing, the
  // loaded manifest's declared `capabilities` array. Neither line below asserts that gating is
  // or is not actually in effect; whether a declared gate is registered is reported only on the
  // operational status endpoint (AC-26), which this page cannot reach.
  const declaresCapabilityGate = $derived(
    data.manifest?.capabilities.includes('capability-gate') ?? false
  )

  // Story 23.8 AC-26: same honest-placeholder bar as AC-9 above — declaration-presence only, no
  // liveness/activity claim (this page cannot reach the operational /status endpoint).
  const declaresAuditEventSource = $derived(
    data.manifest?.capabilities.includes('audit-event-source') ?? false
  )
</script>

<svelte:head>
  <title>Extensions | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Extensions</h1>
  <p class="mt-2 text-gray-500">See whether a configured extension is loaded for this vault.</p>

  {#if !data.allowed}
    <!-- AC-5: 'owner' is deliberately included here too — this page's admin gate does not treat
         owner as admin-equivalent, mirroring the API's own allowedRoles: ['admin']. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">You need the Admin role to view extension status.</p>
      <a href={resolve('/settings')} class="mt-2 inline-block text-sm text-indigo-600 underline">
        ← Back to Settings
      </a>
    </div>
  {:else if data.mfaRequired}
    <!-- AC-7 edge: distinct from both the generic fetch-failure and the permission message —
         retrying won't help, enrolling in MFA will. -->
    <div class="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6">
      <p class="text-amber-900">Enable multi-factor authentication to view extension status.</p>
      <a
        href={resolve('/settings/security')}
        class="mt-2 inline-block text-sm font-medium text-indigo-600 underline"
      >
        Go to Security →
      </a>
    </div>
  {:else if data.errorMessage}
    <!-- AC-7: an honest, retry-worthy fetch failure — the rest of the page stays intact. -->
    <p
      class="mt-8 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {data.errorMessage}
    </p>
  {:else if data.manifest}
    <!-- AC-2: loaded state — the real manifest. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-medium text-emerald-700">Loaded</p>
      <p class="mt-2 text-lg font-semibold text-slate-900">{data.manifest.name}</p>
      <p class="mt-1 text-sm text-slate-600">Version {data.manifest.apiVersion}</p>

      <div class="mt-4">
        {#if data.manifest.capabilities.length === 0}
          <p class="text-sm text-slate-500">No capabilities declared</p>
        {:else}
          <div class="flex flex-wrap gap-2">
            <!-- Keyed by index, not value: the API's capabilities schema
                 (apps/api/src/extensions/status-routes.ts) only validates enum membership, not
                 array uniqueness, so a malformed manifest could declare the same capability
                 twice — a value-keyed {#each} would crash the whole page with a Svelte
                 each_key_duplicate error in that case (confirmed via a manual repro during code
                 review). Index keys tolerate duplicates without changing the rendered output. -->
            {#each data.manifest.capabilities as capability, index (index)}
              <span
                class="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700"
              >
                {capability}
              </span>
            {/each}
          </div>
        {/if}
      </div>

      <p class="mt-4 text-xs text-slate-500">
        Loaded at {formatLoadedAt(data.manifest.loadedAt)}
      </p>

      <!-- Story 23.3 AC-9/AC-33: manifest-derived only — see the declaresCapabilityGate comment
           above for why the copy stops short of a liveness claim. -->
      <p class="mt-3 text-xs text-slate-500">
        {#if declaresCapabilityGate}
          This extension declares a capability gate. Whether it is actually registered is reported
          on the operational status endpoint.
        {:else}
          No capability gate configured — all capabilities are available.
        {/if}
      </p>

      <!-- Story 23.8 AC-26 -->
      <p class="mt-1 text-xs text-slate-500">
        {#if declaresAuditEventSource}
          Audit event source: declared
        {:else}
          Audit event source: not declared — extension domain events are not being written to the
          audit log.
        {/if}
      </p>
    </div>
  {:else if data.healthStatus === 'load_failed'}
    <!-- AC-4: honest, visually/textually distinct from AC-3's not-configured state. Never
         surfaces the raw failure reason — points at server logs / the audit log instead.
         No link to /settings/audit: that page gates on org role 'owner', a stricter role than
         this page's 'admin' gate (AC-5) — every viewer who can reach this branch is 'admin', so
         a link here would always point at a permission wall. Text reference only. -->
    <div class="mt-8 rounded-2xl border border-red-200 bg-red-50 p-6">
      <p class="text-red-800">
        The configured extension failed to load. Core vault functionality is unaffected. Check the
        server's structured logs and this org's audit log for details.
      </p>
      <p class="mt-3 text-xs text-red-700">
        No capability gate configured — all capabilities are available.
      </p>
      <!-- Story 23.8 AC-26 -->
      <p class="mt-1 text-xs text-red-700">
        Audit event source: not declared — extension domain events are not being written to the
        audit log.
      </p>
    </div>
  {:else}
    <!-- AC-3: the expected, common, non-error default for most self-hosted installs. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">No extension configured for this vault.</p>
      <p class="mt-3 text-xs text-slate-500">
        No capability gate configured — all capabilities are available.
      </p>
      <!-- Story 23.8 AC-26 -->
      <p class="mt-1 text-xs text-slate-500">
        Audit event source: not declared — extension domain events are not being written to the
        audit log.
      </p>
    </div>
  {/if}
</div>
