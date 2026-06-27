import fjwt from '@fastify/jwt'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'

export const jwtPlugin = fp(async function jwtPlugin(fastify: FastifyInstance): Promise<void> {
  // env.ts rejects missing production secrets at import time. This fallback only protects
  // concurrent unit tests that temporarily mutate process.env while creating apps.
  const secret = env.SESSION_SECRET || process.env['SESSION_SECRET'] || 'a'.repeat(64)
  await fastify.register(fjwt, {
    secret,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
    cookie: {
      cookieName: 'access-token',
      signed: false,
    },
  })
})
