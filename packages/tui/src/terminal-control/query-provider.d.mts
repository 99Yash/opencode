export type QueryHandler = (
  params: unknown,
  context: { readonly id: number; readonly name: string },
) => unknown | Promise<unknown>

export function provideTerminalControlQueries(options: {
  readonly application: { readonly name: string; readonly version?: string }
  readonly queries: Readonly<Record<string, QueryHandler>>
  readonly socketPath?: string | null
  readonly onError?: (error: unknown) => void
}): {
  readonly enabled: boolean
  readonly ready: Promise<boolean>
  close(): void
}
