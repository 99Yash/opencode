export interface SemanticProvider {
  readonly enabled: boolean
  readonly ready: Promise<boolean>
  close(): void
}

export function provideTerminalControlSemanticSnapshot(options: {
  readonly application: { readonly name: string; readonly version?: string }
  readonly snapshot: () => unknown | Promise<unknown>
  readonly socketPath?: string | null
  readonly onError?: (error: unknown) => void
}): SemanticProvider
