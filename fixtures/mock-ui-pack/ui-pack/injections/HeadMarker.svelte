<!-- M3: a `shell.head` contribution. PV renders the point INSIDE its own <svelte:head>, so the
     contribution is plain head markup: a nested <svelte:head> here makes the client rebuild the head
     (a hydration mismatch) and drops the stylesheet link. -->
<meta name="mock-ui-pack-injected" content="m3-shell-head" />
