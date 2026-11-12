/**
 * Story 73.7 — typed service-endpoint limits resolver. Distinct from `CapabilityGate`, which
 * answers only boolean entitlement. All fields on the returned object are optional so an
 * extension can supply a partial overlay; omitted fields stay default-open.
 */
export type ServiceEndpointLimits = {
  healthChecksEnabled?: boolean
  maxEndpoints?: number
  minCheckIntervalSeconds?: number
}

export type ServiceEndpointLimitsContext = {
  orgId: string
  projectId: string
  /**
   * PV-generated per invocation. Never Fastify `request.id` (that header can be caller-controlled).
   */
  callId: string
}

export type ServiceEndpointLimitsResolver = {
  onResolveServiceEndpointLimits(
    context: ServiceEndpointLimitsContext
  ): Promise<ServiceEndpointLimits>
}
