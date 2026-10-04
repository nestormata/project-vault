<script lang="ts">
  import { getAppliedTheme } from '$lib/state/theme.svelte.js'
</script>

<!-- Story 68-15: reads PV's shared theme rune, so a theme change re-renders it without a reload. -->
<p data-testid="inject-theme" data-marker="PV_INJECT_THEME_MARKER_5a90d3">
  theme:{getAppliedTheme() ?? 'light'}
</p>
