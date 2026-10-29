<!--
  @pv-stable: the props contract ({ size, variant, type, disabled, fullWidth, onclick, children }) is
  final (Story 72.3). A button: content width unless `fullWidth`, `type="button"` unless told
  otherwise (never an accidental submit).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { buttonClass, type ButtonSize, type ButtonVariant } from './control-classes.js'

  let {
    size = 'md',
    variant = 'primary',
    type = 'button',
    disabled = false,
    fullWidth = false,
    onclick,
    children,
  }: {
    size?: ButtonSize
    variant?: ButtonVariant
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    fullWidth?: boolean
    onclick?: (event: MouseEvent) => void
    children?: Snippet
  } = $props()
</script>

<button class={buttonClass(size, variant, fullWidth)} {type} {disabled} {onclick}>
  {@render children?.()}
</button>
