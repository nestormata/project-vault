declare module 'fastify' {
  interface FastifyRequest {
    authContext?: unknown // Story 1.11 replaces with full AuthContext type
  }
}
