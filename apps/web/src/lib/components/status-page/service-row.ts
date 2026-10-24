// Story 69.3: the shapes shared by the status page admin screen (which owns the selection state)
// and its "Services shown on the public page" region (which renders it).
export type SelectedService = { serviceId: string; displayName: string }

/** One merged row: the selected services first, then the endpoints not selected yet. */
export type ServiceRow = {
  id: string
  label: string
  current: SelectedService | undefined
  index: number
}

/** What the services list and each of its rows share: the page owns the selection, the rows call back. */
export type ServiceRowCallbacks = {
  onToggle: (service: { id: string; name: string }) => void
  onSetDisplayName: (serviceId: string, displayName: string) => void
  onMove: (index: number, direction: -1 | 1) => void | Promise<void>
}
