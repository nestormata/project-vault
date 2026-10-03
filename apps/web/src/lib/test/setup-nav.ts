// Story 68.7 AC-8: every PV unit test renders PV's own nav. The active delta is pinned to `{}` here
// (a Vitest setup file, so its mock applies to every test file), which keeps PV's tests valid when
// they run over a composed tree whose `virtual:pv-nav` holds CM's delta (story 68-9). A test of a
// delta passes one explicitly; the shipped `composed-nav.test.ts` imports the virtual module itself.
import { vi } from 'vitest'

vi.mock('$lib/navigation/active-delta.js', () => ({ activeDelta: Object.freeze({}) }))
