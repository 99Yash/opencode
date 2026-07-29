export function createSingleFlightAcknowledgement<Correlation>(timeoutMs = 5_000) {
  let pending:
    | {
        readonly id: string
        readonly correlation: Correlation
        readonly result: PromiseWithResolvers<boolean>
        readonly timer: ReturnType<typeof setTimeout>
      }
    | undefined

  const settle = (id: string, accepted: boolean) => {
    if (pending?.id !== id) return
    clearTimeout(pending.timer)
    pending.result.resolve(accepted)
    pending = undefined
  }

  return {
    begin(id: string, correlation: Correlation) {
      if (pending) return { started: false, promise: Promise.resolve(false) } as const
      const result = Promise.withResolvers<boolean>()
      pending = {
        id,
        correlation,
        result,
        timer: setTimeout(() => settle(id, false), timeoutMs),
      }
      return { started: true, promise: result.promise } as const
    },
    current() {
      return pending ? { id: pending.id, correlation: pending.correlation } : undefined
    },
    settle,
    close() {
      if (pending) settle(pending.id, false)
    },
  }
}
