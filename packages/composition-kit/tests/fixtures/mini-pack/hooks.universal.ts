import type { Reroute, Transport } from '@sveltejs/kit'
import { Money } from './src/lib/cm-money.js'

// A CM universal hook contribution (Story 68-6): `/go/settings[/...]` renders PV's settings routes. PV's
// gate keys on the matched route id too, so the reroute cannot bypass protection (Q5).
const UNIVERSAL_MARKER = 'PV_HOOKS_UNIVERSAL_MARKER_2b9e47'

const GO_SETTINGS = '/go/settings'

// `/go/settings/<page>` renders `/settings/<page>` (its form actions too).
export const reroute: Reroute = ({ url }) => {
  if (url.searchParams.has(UNIVERSAL_MARKER)) return '/settings'
  if (url.pathname === GO_SETTINGS || url.pathname.startsWith(`${GO_SETTINGS}/`))
    return `/settings${url.pathname.slice(GO_SETTINGS.length)}`
  return undefined
}

export const transport: Transport = {
  Money: {
    encode: (value) => value instanceof Money && [value.amount, value.currency],
    decode: ([amount, currency]: [number, string]) => new Money(amount, currency),
  },
}
