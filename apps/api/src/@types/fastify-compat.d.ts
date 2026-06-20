// TypeScript ESM/CJS interop compatibility shim for Fastify v5 default import usage.
import type { FastifyServerOptions } from 'fastify'
import type { FastifyInstance } from 'fastify/types/instance'

declare module 'fastify' {
  const _default: (opts?: FastifyServerOptions) => FastifyInstance & PromiseLike<FastifyInstance>
  export default _default
}
