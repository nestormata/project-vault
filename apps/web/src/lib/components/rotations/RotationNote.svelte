<script lang="ts">
  // Story 69.14: a one-line status note of the rotation detail page (member read-only notice,
  // advisory checklist note, retired and abandoned notes), differing only in tone and role.
  const TONES = {
    slate: 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700',
    sky: 'rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900',
    emerald: 'rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900',
  } as const

  let { tone, text, role }: { tone: keyof typeof TONES; text: string; role?: 'note' } = $props()
</script>

<p class={TONES[tone]} {role}>
  {text}
</p>
