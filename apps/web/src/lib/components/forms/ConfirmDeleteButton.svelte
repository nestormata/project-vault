<script lang="ts">
  // Story 6.4 Dev Notes: a shared two-step confirm control (same-button relabel-and-reclick, not
  // a modal, not native window.confirm()) for the ~5 destructive/permanent actions this story
  // introduces (services/certificates/domains/service-endpoints delete, alert dismiss). State is
  // component-local ($state), so clicking "Delete" on one row never arms a different row's button.
  let {
    label = 'Delete',
    confirmLabel = 'Confirm delete?',
    pendingLabel = 'Deleting…',
    disabled = false,
    // Story 6.6: non-destructive two-step actions (e.g. rotate/regenerate a link) reuse this same
    // relabel-and-reclick pattern but must not look identical to an adjacent, genuinely
    // irreversible action (e.g. Disable) — 'neutral' opts out of the red/danger styling below.
    variant = 'danger',
    onConfirm,
  }: {
    label?: string
    confirmLabel?: string
    pendingLabel?: string
    disabled?: boolean
    variant?: 'danger' | 'neutral'
    onConfirm: () => void | Promise<void>
  } = $props()

  let confirming = $state(false)
  let pending = $state(false)

  async function handleClick() {
    if (disabled || pending) return
    if (!confirming) {
      confirming = true
      return
    }
    pending = true
    try {
      await onConfirm()
    } finally {
      pending = false
      confirming = false
    }
  }
</script>

<button
  type="button"
  class="rounded-xl border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 {variant ===
  'danger'
    ? 'border-red-300 text-red-700'
    : 'border-slate-300 text-slate-900'}"
  disabled={disabled || pending}
  onclick={() => void handleClick()}
>
  {pending ? pendingLabel : confirming ? confirmLabel : label}
</button>
