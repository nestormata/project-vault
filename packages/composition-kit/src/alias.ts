/** The `kit.alias` fragment for the composed app's `svelte.config.js`: `$cm` points at the
 * directory the composer materializes CM code into. The composer never writes `svelte.config.js`.
 *
 *   alias: { ...cmAlias() }
 */
export function cmAlias(): Record<string, string> {
  return { $cm: 'src/lib/_cm' }
}
