// A CM value type that crosses the server/client boundary through the universal `transport` hook.
export class Money {
  constructor(
    readonly amount: number,
    readonly currency: string
  ) {}
}
