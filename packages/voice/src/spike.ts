#!/usr/bin/env bun
// Voice control spike: bridges the local microphone and speaker to the OpenAI
// Realtime API (gpt-realtime-2.1) and exposes OpenCode session control as
// realtime function tools, so you can drive OpenCode with your voice.
//
// Usage:
//   opencode serve   (or note the URL of a running server)
//   2password run --env "OPENAI_API_KEY=op://Personal/OpenAI API Key/credential" -- \
//     bun packages/voice/src/spike.ts --server http://localhost:4096 [--directory /path/to/project]
//
// Requires sox (`brew install sox`) for mic capture (`rec`) and playback (`play`).

import { parseArgs } from "node:util"
import { OpenCode } from "@opencode-ai/client/promise"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode-ai/client/promise"

const args = parseArgs({
  options: {
    server: { type: "string" },
    directory: { type: "string", default: process.cwd() },
    model: { type: "string", default: "gpt-realtime-2.1" },
    voice: { type: "string", default: "marin" },
    password: { type: "string" },
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
    // Log every realtime event type as it arrives.
    debug: { type: "boolean", default: false },
  },
}).values

if (!args.server) {
  console.error("Usage: bun src/spike.ts --server http://localhost:PORT [--directory /path]")
  console.error("Start a server first with `opencode serve` and pass its URL.")
  process.exit(1)
}
const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("OPENAI_API_KEY is required. Run via:")
  console.error(`  2password run --env "OPENAI_API_KEY=op://Personal/OpenAI API Key/credential" -- bun src/spike.ts ...`)
  process.exit(1)
}

const password = args.password ?? process.env["OPENCODE_SERVER_PASSWORD"]
const client = OpenCode.make({
  baseUrl: args.server,
  headers: password ? { Authorization: "Basic " + btoa("opencode:" + password) } : undefined,
})
const health = await client.health.get().catch((error) => {
  console.error(`Could not reach the opencode server at ${args.server}: ${error}`)
  console.error("If the server printed a password on startup, pass it with --password <value>")
  console.error("or export OPENCODE_SERVER_PASSWORD.")
  process.exit(1)
})
// ---------------------------------------------------------------------------
// OpenCode tool surface exposed to the realtime model
// ---------------------------------------------------------------------------

let activeSessionID: string | undefined
let lastPromptAt = 0

function assistantText(message: SessionMessageAssistant) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function latestAssistant(messages: ReadonlyArray<SessionMessageInfo>) {
  return messages.find((message): message is SessionMessageAssistant => message.type === "assistant")
}

async function requireSession() {
  if (activeSessionID) return activeSessionID
  const created = await client.session.create({ location: { directory: args.directory! } })
  activeSessionID = created.id
  ui.meta(`[session] created ${activeSessionID}`)
  ui.setStatus({ session: activeSessionID })
  return created.id
}

const truncate = (text: string, max = 2000) => (text.length > max ? text.slice(0, max) + "…" : text)

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
    })
  : createConsoleUI()
ui.setStatus({ server: args.server })
ui.meta(`opencode ${args.server} (version ${health.version})`)
ui.meta(`project ${args.directory}`)

const toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  list_sessions: async (input) => {
    const limit = typeof input["limit"] === "number" ? input["limit"] : 10
    const sessions = await client.session.list({ directory: args.directory, limit, order: "desc" })
    return sessions.data.map((session) => ({
      id: session.id,
      title: session.title,
      updated: new Date(session.time.updated).toISOString(),
      active: session.id === activeSessionID,
    }))
  },
  create_session: async () => {
    activeSessionID = undefined
    return { sessionID: await requireSession() }
  },
  select_session: async (input) => {
    const sessionID = input["session_id"]
    if (typeof sessionID !== "string") return { error: "session_id is required" }
    activeSessionID = sessionID
    ui.setStatus({ session: sessionID })
    return { sessionID, active: true }
  },
  prompt_session: async (input) => {
    const text = input["text"]
    if (typeof text !== "string" || text.length === 0) return { error: "text is required" }
    const sessionID = await requireSession()
    lastPromptAt = Date.now()
    await client.session.prompt({ sessionID, text })
    ui.meta(`[prompt] ${truncate(text, 120)}`)
    return { sessionID, admitted: true, hint: "Work runs in the background. Use check_session or wait_for_reply." }
  },
  check_session: async () => {
    if (!activeSessionID) return { error: "no active session" }
    const messages = await client.message.list({ sessionID: activeSessionID, order: "desc", limit: 20 })
    const assistant = latestAssistant(messages.data)
    if (!assistant) return { status: "no assistant reply yet" }
    const tools = assistant.content.filter((part) => part.type === "tool").map((part) => part.name)
    return {
      status: assistant.time.completed ? "completed" : "working",
      finish: assistant.finish,
      runningTools: tools,
      text: truncate(assistantText(assistant)),
    }
  },
  wait_for_reply: async (input) => {
    if (!activeSessionID) return { error: "no active session" }
    const timeout = typeof input["timeout_seconds"] === "number" ? input["timeout_seconds"] : 60
    const deadline = Date.now() + timeout * 1000
    while (Date.now() < deadline) {
      const messages = await client.message.list({ sessionID: activeSessionID, order: "desc", limit: 20 })
      const assistant = latestAssistant(messages.data)
      const done =
        assistant !== undefined &&
        assistant.time.created >= lastPromptAt &&
        assistant.time.completed !== undefined &&
        assistant.finish === "stop"
      if (done) return { status: "completed", text: truncate(assistantText(assistant)) }
      await Bun.sleep(1000)
    }
    return { status: "timeout", hint: "Still working. Check again with check_session." }
  },
  interrupt_session: async () => {
    if (!activeSessionID) return { error: "no active session" }
    await client.session.interrupt({ sessionID: activeSessionID })
    return { interrupted: true }
  },
  set_voice: async (input) => {
    const voice = input["voice"]
    if (typeof voice !== "string" || !voices.includes(voice))
      return { error: `voice must be one of: ${voices.join(", ")}` }
    // Reconnect shortly after replying so the confirmation isn't cut off.
    setTimeout(() => setVoice(voice), 1000)
    return { voice, note: "Switching requires a brief reconnect; conversation memory resets." }
  },
}

const toolDefinitions = [
  {
    type: "function",
    name: "list_sessions",
    description: "List recent OpenCode sessions in the current project.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Max sessions to return (default 10)." } },
      required: [],
    },
  },
  {
    type: "function",
    name: "create_session",
    description: "Create a fresh OpenCode session and make it active.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "select_session",
    description: "Make an existing session the active one.",
    parameters: {
      type: "object",
      properties: { session_id: { type: "string", description: "Session ID from list_sessions." } },
      required: ["session_id"],
    },
  },
  {
    type: "function",
    name: "prompt_session",
    description:
      "Send a task or question to the active OpenCode coding agent. Creates a session if none is active. Returns immediately; the agent works in the background.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The instruction for the coding agent." } },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "check_session",
    description: "Check what the coding agent is doing right now: status, running tools, and its latest reply text.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "wait_for_reply",
    description: "Block until the coding agent finishes its current turn and return its final reply. Use for quick tasks.",
    parameters: {
      type: "object",
      properties: { timeout_seconds: { type: "number", description: "Max seconds to wait (default 60)." } },
      required: [],
    },
  },
  {
    type: "function",
    name: "interrupt_session",
    description: "Stop whatever the coding agent is currently doing in the active session.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "set_voice",
    description: "Change your own speaking voice. Requires a brief reconnect.",
    parameters: {
      type: "object",
      properties: {
        voice: {
          type: "string",
          enum: ["marin", "cedar", "coral", "sage", "ash", "ballad", "alloy", "verse"],
          description: "The voice to switch to.",
        },
      },
      required: ["voice"],
    },
  },
]

const instructions = `You are the voice interface to OpenCode, a coding agent running on the user's machine.
The user talks to you; you control OpenCode with tools. You never write code yourself — the coding agent does.

Guidelines:
- Keep spoken replies short: one or two sentences. This is a hands-free interface.
- When the user asks for coding work, relay it with prompt_session, phrased clearly for a coding agent.
- For quick questions use wait_for_reply and summarize the agent's answer out loud.
- For longer tasks say the work has started, and use check_session when the user asks for status.
- Summarize agent replies conversationally; never read code, diffs, or file paths aloud verbatim unless asked.
- Confirm before interrupting a session or anything destructive.`

// ---------------------------------------------------------------------------
// Realtime session over WebSocket
// ---------------------------------------------------------------------------

type RealtimeItem = {
  type?: string
  name?: string
  call_id?: string
  arguments?: string
  transcript?: string | null
}
type RealtimeEvent = {
  type: string
  delta?: string
  transcript?: string
  item_id?: string
  item?: RealtimeItem
  response?: { output?: ReadonlyArray<RealtimeItem> }
  error?: { type?: string; code?: string; message?: string }
}

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
  if ((await Bun.file(binary).exists()) && Bun.file(binary).lastModified > Bun.file(source).lastModified)
    return binary
  ui.meta("compiling echo-cancellation helper (first run only)...")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(Bun.fileURLToPath(new URL("../.build", import.meta.url)), { recursive: true })
  const compile = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "ignore", stderr: "pipe" })
  if ((await compile.exited) === 0) return binary
  ui.meta(await new Response(compile.stderr).text())
  ui.meta("swiftc failed — falling back to sox audio")
  return undefined
})()

// With echo cancellation the mic stays hot while the assistant speaks and
// voice barge-in is safe on speakers.
const fullDuplex = aecBinary !== undefined || args.duplex

// Voice can't change once a session has produced audio, so switching voices
// reconnects the realtime socket (conversation context resets; the OpenCode
// session is untouched).
const voices = ["marin", "cedar", "coral", "sage", "ash", "ballad", "alloy", "verse"]
let currentVoice = args.voice ?? "marin"
let ws: WebSocket | undefined
let reconnecting = false

const send = (event: Record<string, unknown>) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
}

function setVoice(voice: string) {
  currentVoice = voice
  ui.setStatus({ voice })
  ui.meta(`[voice] switching to ${voice}…`)
  reconnecting = true
  flushPlayback()
  ws?.close(1000)
  connectRealtime()
}

const cycleVoice = () => setVoice(voices[(voices.indexOf(currentVoice) + 1) % voices.length]!)

function interrupt() {
  if (!assistantSpeaking()) return
  send({ type: "response.cancel" })
  flushPlayback()
  ui.meta("[interrupted]")
}

let recorder: ReturnType<typeof Bun.spawn> | undefined
let player: ReturnType<typeof Bun.spawn> | undefined
let audio: ReturnType<typeof Bun.spawn> | undefined // AEC duplex helper (mic + speaker)

// PCM16 mono 24kHz is the realtime API default; sox handles both directions.
const soxFormat = ["-q", "-t", "raw", "-r", "24000", "-e", "signed-integer", "-b", "16", "-c", "1"]

// Estimated wall-clock time when buffered speaker audio finishes playing.
// PCM16 mono at 24kHz is 48 bytes per millisecond.
let playbackEndsAt = 0
const assistantSpeaking = () => Date.now() < playbackEndsAt

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
    ui.setStatus({ audio: args.speakers ? "duplex+aec" : "duplex" })
    ui.meta("mic live — talk any time, even over the assistant")
    for await (const chunk of audio.stdout as ReadableStream<Uint8Array>) {
      if (ws?.readyState === WebSocket.OPEN)
        send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") })
    }
    return
  }
  recorder = Bun.spawn(["rec", ...soxFormat, "-"], { stdout: "pipe", stderr: "ignore" })
  ui.setStatus({ audio: args.duplex ? "duplex (sox)" : "half-duplex (sox)" })
  ui.meta("mic live — start talking")
  if (!args.duplex) ui.meta("mic mutes while the assistant speaks; press any key to interrupt")
  for await (const chunk of recorder.stdout as ReadableStream<Uint8Array>) {
    if (ws?.readyState !== WebSocket.OPEN) continue
    // Half-duplex: drop mic audio while the assistant is audible (plus a
    // short tail) so speaker echo can't barge-in against itself.
    if (!args.duplex && Date.now() < playbackEndsAt + 300) continue
    send({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") })
  }
}

async function forwardHelperLogs(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    for (const line of decoder.decode(chunk).split("\n")) {
      if (line.trim()) ui.meta(line.trim())
    }
  }
}

function playAudio(base64: string) {
  if (!audio) {
    player ??= Bun.spawn(["play", ...soxFormat, "-"], { stdin: "pipe", stderr: "ignore" })
    if (args.debug) void player.exited.then((code) => ui.meta(`[debug] play exited (${code})`))
  }
  const stdin = (audio ?? player)!.stdin as import("bun").FileSink
  const bytes = Buffer.from(base64, "base64")
  stdin.write(bytes)
  stdin.flush()
  playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + bytes.length / 48
}

function flushPlayback() {
  // The AEC helper flushes its queued speaker audio on SIGUSR1 and keeps running.
  if (audio) process.kill(audio.pid, "SIGUSR1")
  player?.kill()
  player = undefined
  playbackEndsAt = 0
}

const createResponse = () =>
  send(args.text ? { type: "response.create", response: { output_modalities: ["text"] } } : { type: "response.create" })

let inflightTools = 0

async function handleFunctionCall(item: RealtimeItem) {
  inflightTools += 1
  const handler = item.name ? toolHandlers[item.name] : undefined
  const output = handler
    ? await handler(JSON.parse(item.arguments ?? "{}")).catch((error) => ({ error: String(error) }))
    : { error: `unknown tool ${item.name}` }
  ui.tool(item.name ?? "unknown", output)
  send({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) },
  })
  createResponse()
  inflightTools -= 1
}

// Keypress interrupt for voice mode without the TUI (the TUI handles its own
// keyboard via useKeyboard).
if (!args.text && process.stdin.isTTY && !tuiActive) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on("data", (data: Buffer) => {
    if (data.includes(3)) return shutdown() // ctrl+c
    if (data.toString() === "v") return cycleVoice()
    interrupt()
  })
}

function connectRealtime() {
  ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${args.model}`, {
    // Bun extension: custom headers on the WebSocket handshake
    headers: { Authorization: `Bearer ${apiKey}` },
  } as unknown as string[])
  ws.addEventListener("open", onOpen)
  ws.addEventListener("message", onMessage)
  ws.addEventListener("close", onClose)
}

function onOpen() {
  reconnecting = false
  ui.meta(`connected to ${args.model} (voice: ${currentVoice})`)
  ui.setStatus({ voice: currentVoice })
  send({
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      tools: toolDefinitions,
      tool_choice: "auto",
      audio: { output: { voice: currentVoice } },
    },
  })
  // Optional extras sent separately so a shape mismatch can't reject the core session config.
  send({
    type: "session.update",
    session: { type: "realtime", audio: { input: { transcription: { model: "whisper-1" } } } },
  })
  send({
    type: "session.update",
    session: {
      type: "realtime",
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            // Default 500ms makes the model jump in during natural pauses.
            silence_duration_ms: 900,
            // In half-duplex mode the server must never auto-cancel a response
            // on detected speech: a trailing word or leaked echo would cut the
            // assistant off mid-sentence. Keypress is the interrupt instead.
            interrupt_response: fullDuplex,
          },
        },
      },
    },
  })
}

function onMessage(event: MessageEvent) {
  const data = JSON.parse(String(event.data)) as RealtimeEvent
  if (args.debug && !data.type?.endsWith(".delta")) ui.meta(`[debug] ${data.type}`)
  switch (data.type) {
    case "session.created":
      if (!args.text) {
        void startMicrophone()
        break
      }
      ui.userTranscript("typed", args.text)
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: args.text }] },
      })
      createResponse()
      break
    case "response.output_text.delta":
      ui.assistantDelta(data.delta ?? "")
      break
    case "response.done": {
      ui.assistantDone()
      const calledFunction = data.response?.output?.some((item) => item.type === "function_call") ?? false
      if (args.text && !calledFunction && inflightTools === 0) shutdown()
      break
    }
    case "input_audio_buffer.speech_started":
      // Voice barge-in needs full duplex (AEC helper or headphones). In
      // half-duplex, speech that slips past the mic gate must not kill
      // playback; keypress is the interrupt.
      if (fullDuplex) flushPlayback()
      break
    case "input_audio_buffer.committed":
      // Reserve the user's slot in the conversation now; the transcript
      // arrives later and must not print after the assistant's reply.
      ui.userCommitted(data.item_id ?? "")
      break
    case "conversation.item.input_audio_transcription.completed":
      ui.userTranscript(data.item_id ?? "", (data.transcript ?? "").trim())
      break
    case "response.output_audio.delta":
      if (data.delta) playAudio(data.delta)
      break
    case "response.output_audio_transcript.delta":
      ui.assistantDelta(data.delta ?? "")
      break
    case "response.output_audio_transcript.done":
      ui.assistantDone()
      break
    case "response.output_item.done":
      if (data.item?.type === "function_call") void handleFunctionCall(data.item)
      break
    case "error":
      ui.meta(`[realtime error] ${data.error?.code}: ${data.error?.message}`)
      break
  }
}

function onClose(event: CloseEvent) {
  if (reconnecting) return
  ui.meta(`realtime connection closed (${event.code})`)
  shutdown()
}

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  recorder?.kill()
  player?.kill()
  audio?.kill()
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  ui.close()
  process.exit(0)
}

// A surviving process keeps the microphone hot and the OpenAI meter running,
// so every terminal-death signal must tear it down.
process.on("SIGINT", shutdown)
process.on("SIGHUP", shutdown)
process.on("SIGTERM", shutdown)

connectRealtime()
