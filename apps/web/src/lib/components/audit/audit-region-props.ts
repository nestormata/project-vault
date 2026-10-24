import type {
  InjectionPointExtras,
  SettingsAuditResultsPointProps,
} from '$lib/components/composition/injection-points.js'
import type { AuditExportController } from './audit-export-controller.svelte.js'
import type { AuditVerifyController } from './audit-verify-controller.svelte.js'

type AuditRegionPoint = 'settings.audit.export' | 'settings.audit.verify' | 'settings.audit.results'

/** Story 69.12: the props every sub-region of the settings audit page shares. `data` is the page's
 * `__inject` map, `pointProps` what the region's injection point receives. */
export interface AuditRegionProps<N extends AuditRegionPoint> {
  pointProps: InjectionPointExtras<N>
  data?: Record<string, readonly unknown[]> | undefined
}

export interface AuditExportRegionProps extends AuditRegionProps<'settings.audit.export'> {
  controller: AuditExportController
}

export interface AuditVerifyRegionProps extends AuditRegionProps<'settings.audit.verify'> {
  controller: AuditVerifyController
}

export type AuditResultsRegionProps = AuditRegionProps<'settings.audit.results'>

export interface AuditSearchRegionProps extends AuditResultsRegionProps {
  filters: SettingsAuditResultsPointProps['filters'] | undefined
}
