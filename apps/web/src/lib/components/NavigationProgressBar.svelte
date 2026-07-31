<script lang="ts">
  import { navigating } from '$app/stores'
  import { onDestroy } from 'svelte'

  const SHOW_DELAY_MS = 180
  let visible = $state(false)
  let revealTimer: ReturnType<typeof setTimeout> | null = null

  function cancelReveal() {
    if (revealTimer !== null) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
  }

  $effect(() => {
    if ($navigating) {
      if (!visible && revealTimer === null) {
        revealTimer = setTimeout(() => {
          revealTimer = null
          visible = true
        }, SHOW_DELAY_MS)
      }
      return
    }

    cancelReveal()
    visible = false
  })

  onDestroy(cancelReveal)
</script>

{#if visible}
  <div
    class="navigation-progress"
    role="status"
    aria-live="polite"
    aria-label="Loading page"
    data-navigation-progress
  >
    <span class="sr-only">Loading page…</span>
    <span class="navigation-progress-bar" data-navigation-progress-bar aria-hidden="true"></span>
  </div>
{/if}

<style>
  .navigation-progress {
    position: fixed;
    inset: 0 0 auto;
    z-index: 50;
    height: 3px;
    pointer-events: none;
  }

  .navigation-progress-bar {
    display: block;
    width: 35%;
    height: 100%;
    background-color: var(--color-brand-600, #4f46e5);
    box-shadow: 0 0 8px rgb(79 70 229 / 55%);
    animation: navigation-progress 1.1s ease-in-out infinite;
  }

  @keyframes navigation-progress {
    0% {
      transform: translateX(-100%);
    }

    100% {
      transform: translateX(300%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .navigation-progress-bar {
      width: 100%;
      box-shadow: none;
      animation: none;
    }
  }
</style>
