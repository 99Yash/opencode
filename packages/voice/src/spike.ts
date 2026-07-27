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
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode-ai/client/promise"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode-ai/client/promise"

const args = parseArgs({
  options: {
    server: { type: "string" },
    directory: { type: "string", default: process.cwd() },
    model: { type: "string", default: "gpt-realtime-2.1" },
    voice: { type: "string", default: "marin" },
    provider: { type: "string", default: "openai" },
    "coding-model": { type: "string", default: "gpt-5.6-sol" },
    variant: { type: "string", default: "medium" },
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
    "reduce-motion": { type: "boolean", default: false },
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
let activeDirectory = args.directory!
let activeProjectID: string | undefined
let lastPromptAt = 0
const selectableProjectIDs = new Set<string>()
const selectableSessionIDs = new Set<string>()

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
  const created = await client.session.create({
    location: { directory: activeDirectory },
    model: {
      providerID: args.provider,
      id: args["coding-model"],
      variant: args.variant,
    },
  })
  activeSessionID = created.id
  ui.meta(`[session] created ${activeSessionID} · ${args["coding-model"]}:${args.variant}`)
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
      reducedMotion: args["reduce-motion"],
    })
  : createConsoleUI()
ui.setStatus({ server: args.server, model: `${args["coding-model"]}:${args.variant}` })
ui.meta(`opencode ${args.server} (version ${health.version})`)
ui.meta(`project ${activeDirectory}`)

const toolError = (message: string, retryable = false) => ({ status: "error", message, retryable })
const projectLabel = (project: { name?: string; worktree: string }) =>
  project.name ?? project.worktree.replaceAll("\\", "/").split("/").at(-1) ?? "project"
const listKnownProjects = async () => {
  const seen = new Set<string>()
  const temporary = realpathSync(tmpdir())
  return (await client.project.list())
    .sort((a, b) => b.time.updated - a.time.updated)
    .filter((project) => {
      if (project.id === "global" || project.worktree.startsWith(temporary) || seen.has(project.worktree)) return false
      seen.add(project.worktree)
      return true
    })
}

const toolHandlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  find_projects: async (input) => {
    const query = typeof input["query"] === "string" ? input["query"].toLowerCase() : undefined
    const limit = typeof input["limit"] === "number" ? input["limit"] : 10
    const projects = (await listKnownProjects())
      .filter((project) => !query || projectLabel(project).toLowerCase().includes(query))
      .slice(0, limit)
    selectableProjectIDs.clear()
    projects.forEach((project) => selectableProjectIDs.add(project.id))
    return {
      status: "ok",
      projects: projects.map((project) => ({
        id: project.id,
        name: projectLabel(project),
        directories: 1 + project.sandboxes.length,
        updated: new Date(project.time.updated).toISOString(),
        active: project.id === activeProjectID,
      })),
    }
  },
  select_project: async (input) => {
    const projectID = input["project_id"]
    if (typeof projectID !== "string" || !selectableProjectIDs.has(projectID))
      return toolError("Select a project ID returned by the latest find_projects call.")
    const project = (await listKnownProjects()).find((item) => item.id === projectID)
    if (!project) return toolError("That project is no longer available.", true)
    activeProjectID = project.id
    activeDirectory = project.worktree
    activeSessionID = undefined
    selectableSessionIDs.clear()
    ui.setStatus({ project: projectLabel(project), session: undefined })
    ui.meta(`[project] selected ${projectLabel(project)}`)
    return { status: "selected", projectID: project.id, name: projectLabel(project) }
  },
  find_sessions: async (input) => {
    const query = typeof input["query"] === "string" ? input["query"] : undefined
    const scope = input["scope"] === "all_projects" ? "all_projects" : "current_project"
    const recency = typeof input["recency"] === "string" ? input["recency"] : "any"
    const limit = typeof input["limit"] === "number" ? input["limit"] : 10
    const durations: Record<string, number> = { day: 86_400_000, week: 604_800_000, month: 2_592_000_000 }
    const threshold = recency === "any" ? 0 : Date.now() - (durations[recency] ?? 0)
    const result = await client.session.list({
      ...(scope === "current_project" ? { directory: activeDirectory } : {}),
      search: query,
      parentID: null,
      limit: recency === "any" ? limit : Math.min(limit * 5, 100),
      order: "desc",
    })
    const projects = new Map((await listKnownProjects()).map((project) => [project.id, projectLabel(project)]))
    const sessions = result.data
      .filter((session) => projects.has(session.projectID) && session.time.updated >= threshold)
      .slice(0, limit)
    selectableSessionIDs.clear()
    sessions.forEach((session) => selectableSessionIDs.add(session.id))
    return {
      status: "ok",
      scope,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        project: projects.get(session.projectID) ?? "project",
        updated: new Date(session.time.updated).toISOString(),
        active: session.id === activeSessionID,
      })),
    }
  },
  select_session: async (input) => {
    const sessionID = input["session_id"]
    if (typeof sessionID !== "string" || !selectableSessionIDs.has(sessionID))
      return toolError("Select a session ID returned by the latest find_sessions call.")
    const session = await client.session.get({ sessionID }).catch(() => undefined)
    if (!session) return toolError("That session is no longer available.", true)
    activeSessionID = session.id
    activeDirectory = session.location.directory
    activeProjectID = session.projectID
    const project = (await listKnownProjects()).find((item) => item.id === session.projectID)
    ui.setStatus({ session: session.id, project: project ? projectLabel(project) : undefined })
    return { status: "selected", sessionID: session.id, title: session.title }
  },
  start_task: async (input) => {
    const text = input["text"]
    if (typeof text !== "string" || text.length === 0) return toolError("Task text is required.")
    if (input["new_session"] === true) activeSessionID = undefined
    const sessionID = await requireSession()
    lastPromptAt = Date.now()
    await client.session.prompt({ sessionID, text })
    ui.meta(`[prompt] ${truncate(text, 120)}`)
    if (input["delivery"] === "background")
      return { status: "started", sessionID, hint: "Use check_session only when the user asks for status." }
    await client.session.wait({ sessionID })
    const messages = await client.message.list({ sessionID, order: "desc", limit: 20 })
    const assistant = latestAssistant(messages.data)
    if (!assistant || assistant.time.created < lastPromptAt)
      return { status: "completed", sessionID, text: "The coding agent finished without a text reply." }
    return { status: "completed", sessionID, text: truncate(assistantText(assistant)) }
  },
  check_session: async () => {
    if (!activeSessionID) return toolError("No active session. Find one or start a task first.")
    const messages = await client.message.list({ sessionID: activeSessionID, order: "desc", limit: 20 })
    const assistant = latestAssistant(messages.data)
    if (!assistant) return { status: "waiting", runningTools: [], text: null }
    const tools = assistant.content.filter((part) => part.type === "tool").map((part) => part.name)
    return {
      status: assistant.time.completed ? "completed" : "working",
      runningTools: tools,
      text: truncate(assistantText(assistant)),
    }
  },
  interrupt_session: async () => {
    if (!activeSessionID) return toolError("No active session to interrupt.")
    await client.session.interrupt({ sessionID: activeSessionID })
    return { status: "interrupted", sessionID: activeSessionID }
  },
  list_pending_permissions: async () => {
    if (!activeSessionID) return toolError("No active session.")
    const requests = await client.permission.list({ sessionID: activeSessionID })
    return {
      status: "ok",
      requests: requests.map((request) => ({
        id: request.id,
        action: request.action,
        resources: request.resources,
      })),
    }
  },
  reply_permission: async (input) => {
    if (!activeSessionID) return toolError("No active session.")
    const requestID = input["request_id"]
    const decision = input["decision"]
    if (typeof requestID !== "string" || (decision !== "allow_once" && decision !== "reject"))
      return toolError("A valid request ID and decision are required.")
    const requests = await client.permission.list({ sessionID: activeSessionID })
    if (!requests.some((request) => request.id === requestID))
      return toolError("That permission request is not pending.", true)
    await client.permission.reply({
      sessionID: activeSessionID,
      requestID,
      reply: decision === "allow_once" ? "once" : "reject",
    })
    return { status: decision === "allow_once" ? "allowed_once" : "rejected", requestID }
  },
  set_voice: async (input) => {
    const voice = input["voice"]
    if (typeof voice !== "string" || !voices.includes(voice))
      return toolError(`Voice must be one of: ${voices.join(", ")}.`)
    setTimeout(() => setVoice(voice), 1000)
    return { status: "switching", voice, note: "Realtime conversation memory resets during reconnect." }
  },
}

const emptyParameters = { type: "object", additionalProperties: false, properties: {}, required: [] }
const toolDefinitions = [
  {
    type: "function",
    name: "find_projects",
    description:
      "Find known OpenCode projects by display name. Returns opaque IDs, never filesystem paths. Use before select_project.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: ["string", "null"], description: "Name fragment, or null for recent projects." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query", "limit"],
    },
  },
  {
    type: "function",
    name: "select_project",
    description: "Select a project returned by find_projects and clear the active session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { project_id: { type: "string", description: "Opaque project ID from find_projects." } },
      required: ["project_id"],
    },
  },
  {
    type: "function",
    name: "find_sessions",
    description:
      "Find root OpenCode sessions by title and recency. Search the current project by default; use all_projects only when the user asks or current-project search misses.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: ["string", "null"], description: "Title words, or null for recent sessions." },
        scope: { type: "string", enum: ["current_project", "all_projects"] },
        recency: { type: "string", enum: ["day", "week", "month", "any"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query", "scope", "recency", "limit"],
    },
  },
  {
    type: "function",
    name: "select_session",
    description: "Select a session returned by the latest find_sessions call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { session_id: { type: "string", description: "Session ID from find_sessions." } },
      required: ["session_id"],
    },
  },
  {
    type: "function",
    name: "start_task",
    description:
      "Send work to the active coding session, creating one if needed. Use wait for quick questions whose answer should be spoken now; use background for coding work.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "Clear instruction for the coding agent." },
        new_session: { type: "boolean", description: "True only when the user explicitly asks for a new session." },
        delivery: { type: "string", enum: ["wait", "background"] },
      },
      required: ["text", "new_session", "delivery"],
    },
  },
  {
    type: "function",
    name: "check_session",
    description: "Check active coding-session status only when the user asks for an update.",
    parameters: emptyParameters,
  },
  {
    type: "function",
    name: "interrupt_session",
    description: "Interrupt active coding work. Call only after the user explicitly confirms the interruption.",
    parameters: emptyParameters,
  },
  {
    type: "function",
    name: "list_pending_permissions",
    description: "List permission requests blocking the active coding session.",
    parameters: emptyParameters,
  },
  {
    type: "function",
    name: "reply_permission",
    description:
      "Allow once or reject a pending permission. Call only after stating the action and resource and receiving the user's explicit decision. Persistent approval is intentionally unavailable.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        request_id: { type: "string", description: "Request ID from list_pending_permissions." },
        decision: { type: "string", enum: ["allow_once", "reject"] },
      },
      required: ["request_id", "decision"],
    },
  },
  {
    type: "function",
    name: "set_voice",
    description: "Change your speaking voice. Requires a brief reconnect and resets realtime conversation memory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        voice: {
          type: "string",
          enum: ["marin", "cedar", "coral", "sage", "ash", "ballad", "alloy", "verse"],
        },
      },
      required: ["voice"],
    },
  },
]

const instructions = `You are the voice interface to OpenCode, a coding agent running on the user's machine.
The user talks to you; you navigate projects and sessions and delegate coding work with tools. You never write code yourself.

Guidelines:
- Keep spoken replies to one or two sentences.
- Use find_projects and select_project for explicit project navigation. Never invent project IDs or expose filesystem paths.
- Use find_sessions to resolve references such as "the audio session". Search the current project first unless the user asks across projects.
- Use start_task with delivery wait for quick questions and background for coding work. Set new_session only when explicitly requested.
- Use check_session only when the user asks for status; do not poll repeatedly.
- Summarize coding-agent replies conversationally; do not read code, diffs, IDs, or paths aloud unless asked.
- Before interrupt_session, state what will stop and obtain explicit confirmation.
- Before reply_permission, state the requested action and resources and obtain an explicit allow-once or reject decision.
- Never claim a tool succeeded when its status is error. Explain failures briefly and offer one retry or an alternative.`

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
  const callID = item.call_id ?? crypto.randomUUID()
  const input = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>
  ui.toolStart(callID, item.name ?? "unknown", input)
  const handler = item.name ? toolHandlers[item.name] : undefined
  const output = handler
    ? await handler(input).catch((error) => ({ error: String(error) }))
    : { error: `unknown tool ${item.name}` }
  ui.toolDone(callID, output)
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
