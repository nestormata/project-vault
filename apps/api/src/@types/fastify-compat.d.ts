// TypeScript ESM/CJS interop compatibility shim for Fastify v5
// With NodeNext module resolution, `export = fastify` from a CJS module
// loses its call signature when imported via ESM `import Fastify from 'fastify'`.
// This shim restores the callable default export type.
//
// Route handler params should be typed using direct submodule imports:
//   import type { FastifyRequest } from 'fastify/types/request.js'
//   import type { FastifyReply } from 'fastify/types/reply.js'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'

declare module 'fastify' {
  const _default: (opts?: FastifyServerOptions) => FastifyInstance & PromiseLike<FastifyInstance>
  export default _default
}
