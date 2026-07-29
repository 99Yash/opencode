import { expect, mock, test } from "bun:test"
import type { AudioSession } from "../src/audio-session"
import type { VoiceConnection, VoiceProtocol, VoiceProtocolEvent, VoiceProtocolOptions } from "../src/protocol"
import type { VoiceUI } from "../src/ui"
import { createVoiceSession } from "../src/voice-session"

test("ignores events from a replaced connection", async () => {
  const setup = makeSession()
  setup.session.start()
  setup.connections[0].emit({ type: "ready" })
  setup.session.cycleVoice()
  await Bun.sleep(0)

  expect(setup.connections).toHaveLength(2)
  setup.connections[0].emit({ type: "assistant.transcript.delta", delta: "stale" })
  setup.connections[1].emit({ type: "assistant.transcript.delta", delta: "current" })
  expect(setup.assistantText).toEqual(["current"])
})

test("resolves work against the connection that requested it", async () => {
  const setup = makeSession()
  setup.session.start()
  setup.connections[0].emit({ type: "ready" })
  setup.connections[0].emit({ type: "tool.started", id: "call-1", name: "find_sessions" })
  setup.connections[0].emit({
    type: "work.requested",
    request: { id: "call-1", name: "find_sessions", input: { query: null } },
  })
  await Bun.sleep(0)

  expect(setup.resolvedWork).toEqual([
    {
      request: { id: "call-1", name: "find_sessions", input: { query: null } },
      output: { status: "ok" },
    },
  ])
})

test("acknowledges a durable notification only after playback", async () => {
  const setup = makeSession()
  setup.session.start()
  setup.connections[0].emit({ type: "ready" })
  setup.session.queueNotification({
    notification: {
      type: "opencode.prompt.completed",
      session_id: "session-1",
      prompt_id: "prompt-1",
      status: "completed",
      text: "done",
    },
    receipt: { sessionID: "session-1", promptID: "prompt-1" },
  })
  await Bun.sleep(0)

  setup.connections[0].emit({ type: "assistant.transcript.delta", delta: "Finished." })
  setup.connections[0].emit({ type: "assistant.done", awaitingWork: false })
  expect(setup.delivered).toEqual([])

  setup.finishPlayback?.("played")
  await Bun.sleep(0)
  expect(setup.delivered).toEqual(["prompt-1"])
})

test("retries a notification whose playback was interrupted", async () => {
  const setup = makeSession()
  setup.session.start()
  setup.connections[0].emit({ type: "ready" })
  setup.session.queueNotification({
    notification: {
      type: "opencode.prompt.completed",
      session_id: "session-1",
      prompt_id: "prompt-1",
      status: "completed",
      text: "done",
    },
    receipt: { sessionID: "session-1", promptID: "prompt-1" },
  })
  await Bun.sleep(0)
  setup.connections[0].emit({ type: "assistant.transcript.delta", delta: "Finished." })
  setup.connections[0].emit({ type: "assistant.done", awaitingWork: false })
  setup.finishPlayback?.("interrupted")
  await Bun.sleep(0)

  expect(setup.delivered).toEqual([])
  expect(setup.connections).toHaveLength(2)
  setup.connections[1].emit({ type: "ready" })
  await Bun.sleep(0)
  expect(setup.connections[1].notifyCalls()).toBe(1)
})

test("closes owned resources once", async () => {
  const setup = makeSession()
  setup.session.start()
  await Promise.all([setup.session.close(), setup.session.close()])
  expect(setup.audioClose).toHaveBeenCalledTimes(1)
  expect(setup.toolClose).toHaveBeenCalledTimes(1)
  expect(setup.connections[0].closeCalls()).toBe(1)
})

test("does not acknowledge nonterminal prompt notifications", async () => {
  const setup = makeSession()
  setup.session.start()
  setup.connections[0].emit({ type: "ready" })
  setup.session.queueNotification({
    notification: {
      type: "opencode.prompt.blocked",
      prompt_id: "prompt-1",
      blocker: "permission",
      session_id: "session-1",
      request_id: "permission-1",
      action: "read",
      resources: ["file.ts"],
    },
  })
  await Bun.sleep(0)
  setup.connections[0].emit({ type: "assistant.transcript.delta", delta: "Permission needed." })
  setup.connections[0].emit({ type: "assistant.done", awaitingWork: false })
  setup.finishPlayback?.("played")
  await Bun.sleep(0)

  expect(setup.delivered).toEqual([])
})

function makeSession() {
  const connections: Array<
    VoiceConnection & { emit(event: VoiceProtocolEvent): void; notifyCalls(): number; closeCalls(): number }
  > = []
  const assistantText: string[] = []
  const resolvedWork: Array<unknown> = []
  const delivered: string[] = []
  const audioClose = mock(() => {})
  const toolClose = mock(async () => {})
  let finishPlayback: ((outcome: "played" | "interrupted" | "inaudible") => void) | undefined
  const ui = {
    meta: mock(() => {}),
    userSpeaking: mock(() => {}),
    userReset: mock(() => {}),
    userAudioLevel: mock(() => {}),
    userCommitted: mock(() => {}),
    userTranscript: mock(() => {}),
    assistantAudio: mock(() => {}),
    assistantPlaybackStopped: mock(() => {}),
    assistantDelta: (text: string) => assistantText.push(text),
    assistantTranscript: mock(() => {}),
    assistantDone: mock(() => {}),
    toolStart: mock(() => {}),
    toolDone: mock(() => {}),
    setStatus: mock(() => {}),
    close: mock(() => {}),
  } satisfies VoiceUI
  const audio = {
    fullDuplex: false,
    microphoneMuted: false,
    speakerMuted: false,
    start: mock(async () => {}),
    toggleMicrophone: mock(() => false),
    toggleSpeaker: mock(() => false),
    isPlaying: () => false,
    play: mock(() => {}),
    finishPlayback: () => {
      const result = Promise.withResolvers<"played" | "interrupted" | "inaudible">()
      finishPlayback = result.resolve
      return result.promise
    },
    flushPlayback: mock(() => {}),
    noteUserCommitted: mock(() => {}),
    noteUserTranscript: mock(() => {}),
    close: audioClose,
  } satisfies AudioSession
  const protocol = {
    name: "realtime",
    inputActivity: "server",
    capabilities: { textInput: true, interruption: true, delegation: false },
    connect(options: VoiceProtocolOptions) {
      const notify = mock(async () => true)
      const close = mock(async () => {})
      const connection = {
        appendAudio: mock(() => {}),
        sendText: mock(() => {}),
        resolveWork: (request, output) => resolvedWork.push({ request, output }),
        resolveDelegation: mock(() => {}),
        notify,
        interrupt: () => true,
        close,
        emit: options.onEvent,
        notifyCalls: () => notify.mock.calls.length,
        closeCalls: () => close.mock.calls.length,
      } satisfies VoiceConnection & {
        emit(event: VoiceProtocolEvent): void
        notifyCalls(): number
        closeCalls(): number
      }
      connections.push(connection)
      return connection
    },
  } satisfies VoiceProtocol
  const session = createVoiceSession({
    protocol,
    connection: {
      apiKey: "test",
      model: "voice-test",
      instructions: "test",
      tools: [],
      fullDuplex: false,
      debug: false,
    },
    initialVoice: "marin",
    voices: ["marin", "cedar"],
    ui,
    audio,
    tools: {
      execute: async () => ({ output: { status: "ok" } }),
      acknowledge: async (receipt) => {
        delivered.push(receipt.promptID)
      },
      close: toolClose,
    },
    delegate: async () => "done",
    onClosed: () => {},
  })
  return {
    session,
    connections,
    assistantText,
    resolvedWork,
    delivered,
    audioClose,
    toolClose,
    get finishPlayback() {
      return finishPlayback
    },
  }
}
