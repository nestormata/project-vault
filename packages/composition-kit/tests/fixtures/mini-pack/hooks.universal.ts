import type { Reroute, Transport } from '@sveltejs/kit'
import { Money } from './src/lib/cm-money.js'

// A CM universal hook contribution (Story 68-6): `/go/settings` renders PV's settings route. PV's
// gate keys on the matched route id too, so the reroute cannot bypass protection (Q5).
const UNIVERSAL_MARKER = 'PV_HOOKS_UNIVERSAL_MARKER_2b9e47'

export const reroute: Reroute = ({ url }) =>
  url.pathname === '/go/settings' || url.searchParams.has(UNIVERSAL_MARKER)
    ? '/settings'
    : undefined

export const transport: Transport = {
  Money: {
    encode: (value) => value instanceof Money && [value.amount, value.currency],
    decode: ([amount, currency]: [number, string]) => new Money(amount, currency),
  },
}
