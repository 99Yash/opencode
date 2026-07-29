import { Schema } from "effect"

export const decodeVoiceToolInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

export type VoiceTool = {
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export type VoiceWorkRequest = {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export type VoiceToolExecution = {
  readonly output: unknown
  readonly admittedPrompt?: {
    readonly sessionID: string
    readonly promptID: string
  }
}

export type VoiceDelegationRequest = {
  readonly id: string
  readonly text: string
}

export type VoiceNotificationRequest = {
  readonly id: string
  readonly text: string
  readonly delegationID?: string
}

export type VoiceAudioTimeline = { readonly startMs: number; readonly endMs: number }

export type VoiceProtocolEvent =
  | { readonly type: "ready" }
  | { readonly type: "user.started" }
  | { readonly type: "user.stopped" }
  | { readonly type: "user.committed"; readonly id: string }
  | { readonly type: "user.transcript"; readonly id: string; readonly text: string; readonly final: boolean }
  | {
      readonly type: "assistant.audio"
      readonly audio: Buffer
      readonly timeline?: VoiceAudioTimeline
    }
  | { readonly type: "assistant.transcript.delta"; readonly delta: string }
  | { readonly type: "assistant.transcript"; readonly text: string }
  | { readonly type: "assistant.done"; readonly awaitingWork: boolean }
  | { readonly type: "tool.started"; readonly id: string; readonly name: string }
  | { readonly type: "work.requested"; readonly request: VoiceWorkRequest }
  | { readonly type: "work.rejected"; readonly request: VoiceWorkRequest; readonly output: unknown }
  | { readonly type: "delegation.requested"; readonly request: VoiceDelegationRequest }
  | { readonly type: "debug"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly code: number }

export type VoiceProtocolOptions = {
  readonly apiKey: string
  readonly model: string
  readonly voice: string
  readonly instructions: string
  readonly tools: ReadonlyArray<VoiceTool>
  readonly fullDuplex: boolean
  readonly debug: boolean
  readonly onEvent: (event: VoiceProtocolEvent) => void
  readonly trace?: (event: string, data?: Record<string, unknown>) => void
}

export type VoiceConnection = {
  appendAudio(audio: Buffer): void
  sendText?(text: string): void
  resolveWork(request: VoiceWorkRequest, output: unknown): void
  resolveDelegation?(request: VoiceDelegationRequest, output: string): void
  notify(notification: VoiceNotificationRequest): Promise<boolean>
  interrupt?(): void
  close(options?: { readonly graceful?: boolean }): Promise<void>
}

export type VoiceProtocol = {
  readonly name: "live" | "realtime"
  readonly inputActivity: "local" | "server"
  readonly capabilities: {
    readonly textInput: boolean
    readonly interruption: boolean
    readonly delegation: boolean
  }
  connect(options: VoiceProtocolOptions): VoiceConnection
}
