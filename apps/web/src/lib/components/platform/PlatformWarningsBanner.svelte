<script lang="ts">
  import { resolve } from '$app/paths'

  interface WarningInfo {
    message: string
    linkHref?: string
    linkText?: string
  }

  interface Props {
    warnings: string[]
    messages: Record<string, WarningInfo>
  }

  let { warnings, messages }: Props = $props()
</script>

{#each warnings as warning (warning)}
  {@const info = messages[warning]}
  {#if info}
    <div
      class="mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="alert"
    >
      <span aria-hidden="true" class="mt-0.5 shrink-0">⚠</span>
      <span>
        {info.message}
        {#if info.linkHref && info.linkText}
          <a href={resolve(info.linkHref)} class="ml-1 underline hover:text-amber-700"
            >{info.linkText} →</a
          >
        {/if}
      </span>
    </div>
  {/if}
{/each}
