export type FastifyInjectResponse = {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  json<T>(): T
}

type FastifyLogger = {
  info: (payload: unknown, message?: string) => void
  warn: (payload: unknown, message?: string) => void
  error: (payload: unknown, message?: string) => void
}

export type FastifyApp = {
  log: FastifyLogger
  setValidatorCompiler: (compiler: unknown) => FastifyApp
  setSerializerCompiler: (compiler: unknown) => FastifyApp
  setErrorHandler: (handler: unknown) => FastifyApp
  register: (plugin: unknown, opts?: unknown) => Promise<unknown>
  get: (path: string, handler: unknown) => FastifyApp
  route: (options: unknown) => FastifyApp
  addHook: (name: string, hook: unknown) => FastifyApp
  decorate?: (name: string, value: unknown) => FastifyApp
  authenticate?: unknown
  inject: (options: unknown) => Promise<FastifyInjectResponse>
  withTypeProvider: <_T>() => FastifyApp
  swagger: () => unknown
  ready: () => Promise<void>
  close: () => Promise<unknown>
  listen: (options: { port: number; host: string }) => Promise<string>
}
