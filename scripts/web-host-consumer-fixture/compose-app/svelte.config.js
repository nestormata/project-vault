import { cmAlias } from '@project-vault/composition-kit'
import { svelteConfig } from '@project-vault/web-host/svelte.config'

// A composed app: the shared aliases point at its own composed vendor/ copy, and `$cm` points at
// the directory the composer materializes CM code into.
export default svelteConfig({ composedRoot: import.meta.dirname, alias: { ...cmAlias() } })
