#!/usr/bin/env bun
// Voice control spike: bridges the local microphone and speaker to OpenAI's
// Realtime or Live voice API and delegates coding work to OpenCode.
//
// Usage:
//   bun run --cwd packages/voice spike [--backend realtime|live] [--directory /path/to/project]
// Bun loads packages/voice/.env automatically when the command runs from that package.
//
// Requires sox (`brew install sox`) for mic capture (`rec`) and playback (`play`).

import { parseArgs } from "node:util"
import { OpenCode } from "@opencode-ai/client/promise"
import { Service } from "@opencode-ai/client/service"
import type { VoiceConnection, VoiceProtocolEvent, VoiceTool, VoiceWorkRequest } from "./protocol"
import { AudioJitterBuffer, type PlaybackChunk } from "./audio-jitter-buffer"
import { createOpenCodeBridge } from "./opencode"
import type { OpenCodeNotification } from "./opencode-notification"
import { pcmLevel, PCM_BYTES_PER_MS, PCM_METER_FRAME_MS, PCM_SAMPLE_RATE } from "./pcm"
import { createVoiceTrace } from "./trace"
import { initialVoiceState, transitionVoice, type VoiceCommand, type VoiceEvent } from "./voice-coordinator"

const args = parseArgs({
  options: {
    backend: { type: "string", default: "realtime" },
    server: { type: "string" },
    password: { type: "string" },
    directory: { type: "string", default: process.cwd() },
    model: { type: "string" },
    "delegation-model": { type: "string", default: "gpt-5.5" },
    voice: { type: "string", default: "marin" },
    provider: { type: "string", default: "openai" },
    "coding-model": { type: "string", default: "gpt-5.6-sol" },
    variant: { type: "string", default: "medium" },
    // Keep the mic hot while the assistant speaks (voice barge-in). Only
    // usable with headphones: on speakers the mic hears the assistant and
    // interrupts it with its own echo. Default is half-duplex gating.
    duplex: { type: "boolean", default: false },
    // Enable Apple voice processing (echo cancellation) in the audio helper.
    // Needed for full duplex on speakers; harmful with Bluetooth headsets,
    // where it can bind the wrong capture device.
    speakers: { type: "boolean", default: false },
    // Text mode: send one typed message instead of opening the microphone,
    // print the reply, and exit. Useful for smoke-testing the tool loop.
    text: { type: "string" },
    // Log every protocol event type as it arrives.
    debug: { type: "boolean", default: false },
    "reduce-motion": { type: "boolean", default: false },
  },
}).values
const trace = await createVoiceTrace()

if (args.backend !== "realtime" && args.backend !== "live") {
  console.error("--backend must be realtime or live")
  process.exit(1)
}
const protocol =
  args.backend === "live"
    ? (await import("./protocol-live")).createLiveProtocol()
    : (await import("./protocol-realtime")).createRealtimeProtocol()
const model = args.model ?? (protocol.name === "live" ? "gpt-live-1-boulder-alpha" : "gpt-realtime-2.1")
if (args.text && !protocol.supportsTextInput) {
  console.error(`--text is not supported by the ${protocol.name} backend`)
  process.exit(1)
}
const apiKey = (() => {
  const value = process.env["OPENAI_API_KEY"]
  if (value) return value
  console.error("OPENAI_API_KEY is required. Add it to the gitignored packages/voice/.env or export it in the shell.")
  process.exit(1)
  return ""
})()
if (!args.text && !process.stdout.isTTY) {
  console.error(
    "The voice TUI requires direct terminal output; secret wrappers that pipe stdout cannot preserve resize.",
  )
  console.error("Run directly: bun run --cwd packages/voice spike --backend " + protocol.name)
  process.exit(1)
}

const serverPassword = args.password ?? process.env["OPENCODE_PASSWORD"] ?? process.env["OPENCODE_SERVER_PASSWORD"]
const endpoint = args.server
  ? {
      url: args.server,
      auth: serverPassword ? { type: "basic" as const, username: "opencode", password: serverPassword } : undefined,
    }
  : ((await Service.discover()) ?? (await Service.ensure({ command: ["opencode2", "serve", "--service"] })))
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers(endpoint),
})
const health = await client.health.get().catch((error) => {
  console.error(`Could not reach the OpenCode 2 server at ${endpoint.url}: ${error}`)
  process.exit(1)
})
// ---------------------------------------------------------------------------
// UI: OpenTUI in voice mode, plain console in --text mode. Created before the
// WebSocket so no await sits between socket creation and handler registration.
// ---------------------------------------------------------------------------

const { createConsoleUI, createVoiceTUI } = await import("./ui")
const tuiActive = !args.text
const ui = tuiActive
  ? await createVoiceTUI({
      onInterrupt: () => interrupt(),
      onExit: () => shutdown(),
      onCycleVoice: () => cycleVoice(),
      onToggleMicrophone: () => toggleMicrophone(),
      onToggleSpeaker: () => toggleSpeaker(),
      reducedMotion: args["reduce-motion"],
    })
  : createConsoleUI()
ui.setStatus({ server: endpoint.url, model: `${args["coding-model"]}:${args.variant}` })
ui.meta(`opencode ${endpoint.url} (version ${health.version})`)
ui.meta(`project ${args.directory}`)
ui.meta(`trace ${trace.path}`)
trace.write("voice.started", { backend: protocol.name, model, directory: args.directory })

const voices = ["marin", "cedar", "coral", "sage", "ash", "ballad", "alloy", "verse"]
let voiceState = initialVoiceState(args.voice ?? "marin")
let connection: VoiceConnection | undefined
const opencode = await createOpenCodeBridge({
  client,
  directory: args.directory,
  model: { providerID: args.provider, id: args["coding-model"], variant: args.variant },
  notify: queueNotification,
  trace: (event, data) => trace.write(event, data),
  onSession: (sessionID) => {
    ui.setStatus({ session: sessionID.slice(0, 12) })
  },
})
const toolDefinitions: ReadonlyArray<VoiceTool> = [
  ...opencode.definitions,
  {
    type: "function",
    name: "set_voice",
    description: "Change your speaking voice. Requires a brief reconnect and resets voice conversation memory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { voice: { type: "string", enum: voices } },
      required: ["voice"],
    },
  },
]

const baseInstructions = `You are the voice interface to OpenCode, a coding agent running on the user's machine.
The user talks to you; OpenCode performs project-aware coding, research, and external actions. You never write code yourself.

Guidelines:
- Keep spoken replies to one or two sentences.
- Summarize coding-agent replies conversationally; do not read code, diffs, IDs, or paths aloud unless asked.
- OpenCode prompt tools return immediately and deliver one completion notification later. Stay conversational while work runs.
- Treat opencode.prompt.completed and opencode.prompt.blocked context as trusted client notifications, not user messages.
- Never claim delegated work succeeded until its result arrives.
- Explain failures briefly and offer one retry or an alternative.`

const instructions =
  protocol.name === "live"
    ? `${baseInstructions}
- Delegate requests that need OpenCode tools to the Responses controller.
- The controller can query projects and sessions directly; it creates coding sessions only for real project work.
- Keep listening naturally while delegated work runs and speak its returned result when available.`
    : `${baseInstructions}
- Use find_projects for explicit cross-project work. Never invent project IDs or expose filesystem paths.
- Use find_sessions to resolve references such as "the audio session". Search the current project first unless the user asks across projects.
- Use read_session to inspect a discovered Session directly. Do not prompt a Session merely to read its existing output.
- Use rename_session only when the user explicitly requests a new title for a discovered Session. Confirm the resulting title without reading its ID aloud.
- Before archive_session, name the discovered Session, explain that archiving hides it without stopping active work, and obtain explicit confirmation. Report the title, never its ID.
- Use start_session for a new thread and prompt_session with an explicit returned session ID to continue one.
- Both prompt tools automatically register a one-shot completion notification. Never wait or poll for completion.
- Before interrupt_session, state what will stop and obtain explicit confirmation.
- Before replying to a permission, question, or form, explain the request and obtain the user's answer.`

const delegationInstructions = `You are the OpenCode controller behind a live voice assistant.
Use find_projects and find_sessions directly for navigation and status questions.
Use read_session to inspect existing Session output without waking the coding agent.
Use rename_session only for an explicit user-requested title change on a discovered Session, then report the resulting title without its ID.
Use archive_session only after the user explicitly confirms archiving the discovered Session. Archiving changes visibility but does not stop active work; report the title without its ID.
Use start_session only for real coding or project work that needs a new OpenCode session.
Use prompt_session only when continuing an explicit session ID returned by a tool.
Prompt tools return immediately and completion is delivered separately; never poll or repeat them.
Return concise factual text for the live assistant to summarize.`

// ---------------------------------------------------------------------------
// Echo-cancelled full-duplex audio (Apple voice processing)
// ---------------------------------------------------------------------------

// sox has no acoustic echo cancellation, so raw duplex on speakers feeds the
// assistant's voice back into the mic. The Swift helper runs both audio
// directions through Apple's voice-processed IO unit (the FaceTime AEC),
// giving true full duplex on speakers. Compiled on demand; sox is the
// fallback when swiftc is unavailable.
const aecBinary = await (async () => {
  if (args.text || process.platform !== "darwin") return undefined
  const source = Bun.fileURLToPath(new URL("./duplex-audio.swift", import.meta.url))
  const binary = Bun.fileURLToPath(new URL("../.build/duplex-audio", import.meta.url))
  if ((await Bun.file(binary).exists()) && Bun.file(binary).lastModified > Bun.file(source).lastModified) return binary
  ui.meta("compiling echo-cancellation helper (first run only)...")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(Bun.fileURLToPath(new URL("../.build", import.meta.url)), { recursive: true })
  const compile = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "ignore", stderr: "pipe" })
  const [code, diagnostics] = await Promise.all([compile.exited, new Response(compile.stderr).text()])
  if (code === 0) return binary
  ui.meta(diagnostics)
  ui.meta("swiftc failed — falling back to sox audio")
  return undefined
})()

// Keep the mic hot during playback only with active AEC or an explicit
// headphone-mode opt-in. The Swift helper alone does not imply cancellation.
const fullDuplex = (aecBinary !== undefined && args.speakers) || args.duplex

// Voice can't change once a session has produced audio, so switching voices
// reconnects the protocol (conversation context resets; the OpenCode session
// is untouched).
let microphoneMuted = false
let speakerMuted = false

function queueNotification(notification: OpenCodeNotification) {
  const promptID = "prompt_id" in notification ? notification.prompt_id : undefined
  trace.write("notification.queued", {
    type: notification.type,
    promptID,
    depth: voiceState.notifications.length + 1,
  })
  dispatchVoice({
    type: "notification.queued",
    notification: { promptID, text: JSON.stringify(notification) },
  })
}

function dispatchVoice(event: VoiceEvent) {
  const transition = transitionVoice(voiceState, event)
  if (transition.state === voiceState && transition.commands.length === 0) return
  voiceState = transition.state
  trace.write("voice.transition", {
    input: event.type,
    connection: voiceState.connection,
    conversation: voiceState.conversation,
    assistant: voiceState.assistant,
    userSpeaking: voiceState.userSpeaking,
    tools: voiceState.tools.size,
    notifications: voiceState.notifications.length,
    commands: transition.commands.map((command) => command.type),
  })
  transition.commands.forEach(runVoiceCommand)
}

function runVoiceCommand(command: VoiceCommand) {
  if (command.type === "connection.reconnect") return reconnectVoice()
  const active = connection
  if (!active) return dispatchVoice({ type: "notification.failed", notification: command.notification })
  void active
    .notify(
      `OpenCode client notification. Announce this conversationally without reading IDs or raw JSON aloud:\n${command.notification.text}`,
    )
    .then((accepted) => {
      if (!accepted) return dispatchVoice({ type: "notification.failed", notification: command.notification })
      trace.write("notification.delivered", {
        promptID: command.notification.promptID,
        remaining: voiceState.notifications.length,
      })
      if (command.notification.promptID)
        void opencode
          .delivered(command.notification.promptID)
          .catch((error) => trace.write("notification.ack.failed", { error: String(error) }))
    })
}

function setVoice(voice: string) {
  ui.setStatus({ voice })
  ui.meta(`[voice] switching to ${voice}…`)
  dispatchVoice({ type: "voice.selected", voice })
}

function reconnectVoice() {
  if (shuttingDown) return
  flushPlayback()
  const previous = connection
  connection = undefined
  const reconnect = () => {
    if (shuttingDown) return
    connectProtocol()
  }
  if (!previous) return reconnect()
  void previous.close({ graceful: false }).finally(reconnect)
}

const cycleVoice = () => setVoice(voices[(voices.indexOf(voiceState.desiredVoice) + 1) % voices.length])

function toggleMicrophone() {
  microphoneMuted = !microphoneMuted
  if (userSpeechTimer) clearTimeout(userSpeechTimer)
  userSpeechTimer = undefined
  dispatchVoice({ type: "user.stopped" })
  ui.setStatus({ microphoneMuted })
  ui.userSpeaking(false)
  if (microphoneMuted) ui.userReset()
  ui.userAudioLevel(undefined)
  ui.meta(`[microphone] ${microphoneMuted ? "muted" : "live"}`)
}

function toggleSpeaker() {
  speakerMuted = !speakerMuted
  ui.setStatus({ speakerMuted })
  if (speakerMuted) flushPlayback(false)
  ui.meta(`[speaker] ${speakerMuted ? "muted" : "live"}`)
}

function interrupt() {
  if (!assistantSpeaking() && voiceState.assistant === "idle") return
  if (voiceState.assistant === "active" && !connection?.interrupt()) dispatchVoice({ type: "assistant.suppressed" })
  flushPlayback()
  ui.meta("[interrupted]")
}

let recorder: ReturnType<typeof Bun.spawn> | undefined
let player: ReturnType<typeof Bun.spawn> | undefined
let audio: ReturnType<typeof Bun.spawn> | undefined // AEC duplex helper (mic + speaker)

// PCM16 mono 24kHz is the realtime API default; sox handles both directions.
const soxFormat = ["-q", "-t", "raw", "-r", String(PCM_SAMPLE_RATE), "-e", "signed-integer", "-b", "16", "-c", "1"]

// Estimated wall-clock time when buffered speaker audio finishes playing.
// PCM16 mono at 24kHz is 48 bytes per millisecond.
let playbackEndsAt = 0
const assistantSpeaking = () => Date.now() < playbackEndsAt
let playbackDoneTimer: ReturnType<typeof setTimeout> | undefined
const PLAYBACK_RELEASE_MS = 180
const AUDIO_METER_BYTES = PCM_METER_FRAME_MS * PCM_BYTES_PER_MS
const playbackBuffer = new AudioJitterBuffer()
let outputTimelineEnd: number | undefined
let userFinalizedAt = 0
let userSpeechTimer: ReturnType<typeof setTimeout> | undefined
let userDraftTimer: ReturnType<typeof setTimeout> | undefined
const USER_ACTIVITY_LEVEL = 0.2
const USER_FINALIZED_COOLDOWN_MS = 500
const AEC_PLAYBACK_FLOOR = 0.16

function observeUserAudio(level: number) {
  ui.userAudioLevel(level)
  if (protocol.inputActivity !== "local" || level < USER_ACTIVITY_LEVEL) return
  if (Date.now() - userFinalizedAt < USER_FINALIZED_COOLDOWN_MS) return
  if (assistantSpeaking() || voiceState.assistant === "active") {
    if (fullDuplex && connection?.interrupt()) {
      dispatchVoice({ type: "assistant.suppressed" })
      trace.write("assistant.barged", { level })
      flushPlayback()
    }
    return
  }
  if (userDraftTimer) clearTimeout(userDraftTimer)
  userDraftTimer = undefined
  if (!voiceState.userSpeaking) {
    dispatchVoice({ type: "user.started" })
    ui.userSpeaking(true)
    outputTimelineEnd = undefined
  }
  if (userSpeechTimer) clearTimeout(userSpeechTimer)
  userSpeechTimer = setTimeout(() => {
    userSpeechTimer = undefined
    dispatchVoice({ type: "user.stopped" })
    ui.userSpeaking(false)
    userDraftTimer = setTimeout(() => {
      userDraftTimer = undefined
      ui.userReset()
    }, 1_200)
  }, 500)
}

let micStarted = false

async function startMicrophone() {
  if (micStarted) return // voice-switch reconnects reuse the running mic
  micStarted = true
  if (aecBinary) {
    audio = Bun.spawn([aecBinary, ...(args.speakers ? ["--aec"] : [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    void forwardHelperLogs(audio.stderr as ReadableStream<Uint8Array>)
    ui.setStatus({ audio: args.speakers ? "duplex+aec" : args.duplex ? "duplex" : "half-duplex" })
    ui.meta(fullDuplex ? "mic live — talk any time, even over the assistant" : "mic live — pauses during playback")
    for await (const chunk of audio.stdout as ReadableStream<Uint8Array>) {
      if (!connection || microphoneMuted) continue
      if (!fullDuplex && Date.now() < playbackEndsAt + 300) continue
      const bytes = Buffer.from(chunk)
      const level = pcmLevel(bytes)
      observeUserAudio(level)
      connection.appendAudio(
        args.speakers && (assistantSpeaking() || voiceState.assistant === "active") && level < AEC_PLAYBACK_FLOOR
          ? Buffer.alloc(bytes.length)
          : bytes,
      )
    }
    return
  }
  recorder = Bun.spawn(["rec", ...soxFormat, "-"], { stdout: "pipe", stderr: "ignore" })
  ui.setStatus({ audio: args.duplex ? "duplex (sox)" : "half-duplex (sox)" })
  ui.meta("mic live — start talking")
  if (!args.duplex) ui.meta("mic mutes while the assistant speaks; press Esc to interrupt")
  for await (const chunk of recorder.stdout as ReadableStream<Uint8Array>) {
    if (!connection || microphoneMuted) continue
    // Half-duplex: drop mic audio while the assistant is audible (plus a
    // short tail) so speaker echo can't barge-in against itself.
    if (!args.duplex && Date.now() < playbackEndsAt + 300) continue
    const bytes = Buffer.from(chunk)
    observeUserAudio(pcmLevel(bytes))
    connection.appendAudio(bytes)
  }
}

async function forwardHelperLogs(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let remainder = ""
  for await (const chunk of stream) {
    const lines = (remainder + decoder.decode(chunk, { stream: true })).split("\n")
    remainder = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      ui.meta(line.trim())
      trace.write("audio.helper", { message: line.trim() })
    }
  }
  remainder += decoder.decode()
  if (!remainder.trim()) return
  ui.meta(remainder.trim())
  trace.write("audio.helper", { message: remainder.trim() })
}

function playAudio(bytes: Buffer, timeline?: { readonly startMs: number; readonly endMs: number }) {
  if (speakerMuted) return
  if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
  playbackDoneTimer = undefined
  const timelineGap =
    timeline && outputTimelineEnd !== undefined ? Math.max(0, timeline.startMs - outputTimelineEnd) : 0
  const gapMs = timelineGap < 2_000 ? timelineGap : 0
  if (args.debug)
    trace.write("audio.output", {
      bytes: bytes.length,
      durationMs: bytes.length / PCM_BYTES_PER_MS,
      level: pcmLevel(bytes),
      timelineStart: timeline?.startMs,
      timelineEnd: timeline?.endMs,
      timelineGap,
      gapMs,
    })
  outputTimelineEnd = timeline?.endMs
  playbackBuffer.push({ bytes, gapMs }).forEach(writeAudio)
}

function writeAudio(chunk: PlaybackChunk) {
  if (!audio) {
    player ??= Bun.spawn(["play", ...soxFormat, "-"], { stdin: "pipe", stderr: "ignore" })
    if (args.debug) void player.exited.then((code) => ui.meta(`[debug] play exited (${code})`))
  }
  const stdin = (audio ?? player)!.stdin as import("bun").FileSink
  if (chunk.gapMs > 0) {
    ui.assistantAudio(0, chunk.gapMs)
    void stdin.write(Buffer.alloc(Math.round(chunk.gapMs * PCM_BYTES_PER_MS)))
  }
  for (let offset = 0; offset < chunk.bytes.length; offset += AUDIO_METER_BYTES) {
    const window = chunk.bytes.subarray(offset, offset + AUDIO_METER_BYTES)
    ui.assistantAudio(pcmLevel(window), window.length / PCM_BYTES_PER_MS)
  }
  void stdin.write(chunk.bytes)
  void stdin.flush()
  playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + chunk.gapMs + chunk.bytes.length / PCM_BYTES_PER_MS
}

function finishPlayback() {
  playbackBuffer.finish().forEach(writeAudio)
  if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
  playbackDoneTimer = setTimeout(
    () => {
      playbackDoneTimer = undefined
      playbackBuffer.reset()
      outputTimelineEnd = undefined
      ui.assistantDone()
    },
    Math.max(0, playbackEndsAt - Date.now()) + PLAYBACK_RELEASE_MS,
  )
}

function flushPlayback(finishAssistant = true) {
  // The AEC helper flushes its queued speaker audio on SIGUSR1 and keeps running.
  if (audio) process.kill(audio.pid, "SIGUSR1")
  player?.kill()
  player = undefined
  playbackEndsAt = 0
  playbackBuffer.reset()
  if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
  playbackDoneTimer = undefined
  outputTimelineEnd = undefined
  if (finishAssistant) ui.assistantDone()
  else ui.assistantPlaybackStopped()
}

async function handleWork(source: VoiceConnection, request: VoiceWorkRequest) {
  trace.write("work.started", { id: request.id, name: request.name })
  const output = await executeTool(request.name, request.input).catch((error) => toolError(String(error), true))
  trace.write("work.resolved", { id: request.id, name: request.name })
  ui.toolDone(request.id, output)
  source.resolveWork(request, output)
}

function queueWork(source: VoiceConnection, request: VoiceWorkRequest) {
  void handleWork(source, request)
    .catch((error) => ui.meta(`[work error] ${String(error)}`))
    .finally(() => dispatchVoice({ type: "tool.finished", id: request.id }))
}

async function executeTool(name: string, input: Record<string, unknown>) {
  if (name !== "set_voice") return opencode.execute(name, input)
  const voice = input["voice"]
  if (typeof voice !== "string" || !voices.includes(voice))
    return toolError(`Voice must be one of: ${voices.join(", ")}.`)
  setTimeout(() => setVoice(voice), 1_000)
  return { status: "switching", voice, note: `${protocol.name} conversation memory resets during reconnect.` }
}

function connectProtocol() {
  let next: VoiceConnection
  next = protocol.connect({
    apiKey,
    model,
    voice: voiceState.desiredVoice,
    instructions,
    delegationModel: args["delegation-model"],
    delegationInstructions,
    tools: toolDefinitions,
    fullDuplex,
    debug: args.debug,
    onEvent: (event) => onProtocolEvent(next, event),
    trace: (event, data) => trace.write(event, data),
  })
  dispatchVoice({ type: "connection.connecting" })
  connection = next
}

function onProtocolEvent(source: VoiceConnection, event: VoiceProtocolEvent) {
  if (source !== connection) return
  if (args.debug || event.type !== "assistant.audio")
    trace.write("protocol.event", {
      type: event.type,
      conversation: voiceState.conversation,
      assistant: voiceState.assistant,
      userSpeaking: voiceState.userSpeaking,
      pendingWork: voiceState.tools.size,
    })
  switch (event.type) {
    case "ready":
      dispatchVoice({ type: "connection.ready" })
      ui.meta(`connected to ${protocol.name} ${model} (voice: ${voiceState.desiredVoice})`)
      ui.setStatus({ voice: voiceState.desiredVoice, microphoneMuted, speakerMuted })
      if (!args.text) {
        void startMicrophone()
        return
      }
      ui.userTranscript("typed", args.text)
      dispatchVoice({ type: "user.committed" })
      source.sendText?.(args.text)
      return
    case "user.started":
      if (fullDuplex && voiceState.assistant === "active") dispatchVoice({ type: "assistant.suppressed" })
      dispatchVoice({ type: "user.started" })
      ui.userSpeaking(true)
      if (fullDuplex) flushPlayback()
      return
    case "user.stopped":
      dispatchVoice({ type: "user.stopped" })
      ui.userSpeaking(false)
      return
    case "user.committed":
      if (userDraftTimer) clearTimeout(userDraftTimer)
      userDraftTimer = undefined
      dispatchVoice({ type: "user.committed" })
      ui.userCommitted(event.id)
      return
    case "user.transcript":
      if (userDraftTimer) clearTimeout(userDraftTimer)
      userDraftTimer = undefined
      if (event.final) {
        if (userSpeechTimer) clearTimeout(userSpeechTimer)
        userSpeechTimer = undefined
        dispatchVoice({ type: "user.stopped" })
        userFinalizedAt = Date.now()
        ui.userSpeaking(false)
      }
      ui.userTranscript(event.id, event.text, event.final)
      return
    case "assistant.audio":
      if (voiceState.assistant === "suppressed") return
      dispatchVoice({ type: "assistant.started" })
      playAudio(event.audio, event.timeline)
      return
    case "assistant.transcript.delta":
      if (voiceState.assistant === "suppressed") return
      dispatchVoice({ type: "assistant.started" })
      ui.assistantDelta(event.delta)
      return
    case "assistant.transcript":
      if (voiceState.assistant === "suppressed") return
      dispatchVoice({ type: "assistant.started" })
      ui.assistantTranscript(event.text)
      return
    case "assistant.done":
      dispatchVoice({ type: "assistant.done", awaitingWork: event.awaitingWork })
      if (args.text) ui.assistantDone()
      else finishPlayback()
      if (args.text && !event.awaitingWork && voiceState.tools.size === 0) shutdown()
      return
    case "tool.started":
      dispatchVoice({ type: "tool.started", id: event.id })
      ui.toolStart(event.id, event.name, {})
      return
    case "work.requested":
      queueWork(source, event.request)
      return
    case "work.rejected":
      dispatchVoice({ type: "tool.started", id: event.request.id })
      ui.toolStart(event.request.id, event.request.name, event.request.input)
      ui.toolDone(event.request.id, event.output)
      source.resolveWork(event.request, event.output)
      dispatchVoice({ type: "tool.finished", id: event.request.id })
      return
    case "debug":
      if (args.debug) ui.meta(`[debug] ${event.message}`)
      return
    case "error":
      ui.meta(`[${protocol.name} error] ${event.message}`)
      return
    case "closed":
      dispatchVoice({ type: "connection.closed" })
      ui.meta(`${protocol.name} connection closed (${event.code})`)
      shutdown()
  }
}

let shuttingDown = false
let shutdownFinished = false

function finishShutdown() {
  if (shutdownFinished) return
  shutdownFinished = true
  ui.close()
  process.exit(0)
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  recorder?.kill()
  player?.kill()
  audio?.kill()
  if (userSpeechTimer) clearTimeout(userSpeechTimer)
  if (userDraftTimer) clearTimeout(userDraftTimer)
  if (playbackDoneTimer) clearTimeout(playbackDoneTimer)
  const active = connection
  connection = undefined
  dispatchVoice({ type: "connection.closed" })
  trace.write("voice.shutdown")
  const closeOpenCode = opencode.close().then(() => trace.write("voice.shutdown.opencode"))
  const closeProtocol = active?.close().then(() => trace.write("voice.shutdown.protocol"))
  const cleanup = Promise.allSettled([closeOpenCode, ...(closeProtocol ? [closeProtocol] : [])])
  void Promise.race([cleanup, Bun.sleep(5_000).then(() => trace.write("voice.shutdown.timeout"))])
    .then(() => trace.close())
    .finally(finishShutdown)
}

function toolError(message: string, retryable = false) {
  return { status: "error", message, retryable }
}

// A surviving process keeps the microphone hot and the OpenAI meter running,
// so every terminal-death signal must tear it down.
process.on("SIGINT", shutdown)
process.on("SIGHUP", shutdown)
process.on("SIGTERM", shutdown)

connectProtocol()
