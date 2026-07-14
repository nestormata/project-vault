<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head>
  <title>Version & Upgrade | Platform Admin | Project Vault</title>
</svelte:head>

{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <nav class="mb-4 text-sm text-gray-500">
      <a href={resolve('/platform')} class="hover:underline">Platform Admin</a>
      <span class="mx-2">›</span>
      <span>Version &amp; Upgrade</span>
    </nav>

    <h1 class="text-2xl font-bold text-gray-900">Version &amp; Upgrade</h1>

    <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
      <h2 class="text-base font-semibold text-gray-900">Current Version</h2>
      {#if data.version}
        <p class="mt-2 text-sm text-gray-700">Running version <strong>{data.version}</strong>.</p>
      {:else}
        <p class="mt-2 text-sm text-gray-500">Version information unavailable.</p>
      {/if}
    </section>

    <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
      <h2 class="text-base font-semibold text-gray-900">Upgrade Procedure</h2>
      <div class="mt-3 space-y-3 text-sm text-gray-700">
        <p>
          Project Vault supports <strong>in-place upgrades</strong> via
          <code class="font-mono text-xs">docker compose up -d</code>
          with a newer image. The migration system applies only
          <strong>additive schema migrations</strong>
          automatically on startup — no destructive changes (column drops, renames, table drops) are ever
          applied automatically.
        </p>
        <p>
          If a future version requires a destructive migration, an explicit offline procedure is
          documented in the runbook. Always back up before upgrading.
        </p>
        <p>
          <a
            href="https://github.com/nestormata/project-vault/blob/main/docs/runbook.md#upgrades"
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-indigo-600 underline"
          >
            → Upgrade procedure (docs/runbook.md § Upgrades)
          </a>
        </p>
      </div>
    </section>

    <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
      <h2 class="text-base font-semibold text-gray-900">API Documentation</h2>
      <div class="mt-3 text-sm text-gray-700">
        {#if data.apiDocsEnabled}
          <a
            href={resolve('/api/v1/docs')}
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-indigo-600 underline"
          >
            Open API Documentation (Swagger UI) →
          </a>
        {:else}
          <p class="text-gray-500">
            API documentation browsing is not enabled on this instance. Set
            <code class="font-mono text-xs">ENABLE_API_DOCS=true</code> to enable it.
          </p>
        {/if}
      </div>
    </section>
  </div>
{/if}
