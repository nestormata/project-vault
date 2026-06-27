import fp from 'fastify-plugin'
import { requireMfaEnrollment } from '../modules/auth/mfa-enforcement.js'

export default fp(async (fastify) => {
  fastify.decorate('requireMfaEnrollment', requireMfaEnrollment)
})
