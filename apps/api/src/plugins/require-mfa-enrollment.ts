import fp from 'fastify-plugin'
import { requireMfaEnrollment } from '../modules/auth/mfa-enforcement.js'

export default fp((fastify) => {
  fastify.decorate('requireMfaEnrollment', requireMfaEnrollment)
  return Promise.resolve()
})
