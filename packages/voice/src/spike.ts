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
import { createAudioSession, type AudioSession } from "./audio-session"
import type { OpenCodeAnnouncement } from "./opencode-notification"
import { createVoiceTrace } from "./trace"
import {
  createResponsesControllerContext,
  responsesControllerTools,
  runResponsesController,
} from "./responses-controller"
import { createVoiceSession, voiceControlTool, type VoiceSession } from "./voice-session"

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
let audioSession: AudioSession | undefined
let voiceSession: VoiceSession | undefined

if (args.backend !== "realtime" && args.backend !== "live") {
  console.error("--backend must be realtime or live")
  process.exit(1)
}
const protocol =
  args.backend === "live"
    ? (await import("./protocol-live")).createLiveProtocol()
    : (await import("./protocol-realtime")).createRealtimeProtocol()
const model = args.model ?? (protocol.name === "live" ? "gpt-live-1-boulder-alpha" : "gpt-realtime-2.1")
if (args.text && !protocol.capabilities.textInput) {
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
  console.error("The voice TUI requires direct terminal access for screen rendering and keyboard input.")
  console.error("1Password output masking pipes stdout, so `2password run` cannot host this interactive TUI.")
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
const trace = await createVoiceTrace()
// ---------------------------------------------------------------------------
// UI: OpenTUI in voice mode, plain console in --text mode. Created before the
// WebSocket so no await sits between socket creation and handler registration.
// ---------------------------------------------------------------------------

const { createConsoleUI, createVoiceTUI } = await import("./ui")
const tuiActive = !args.text
const ui = tuiActive
  ? await createVoiceTUI({
      onInterrupt: () => voiceSession?.interrupt(),
      onExit: () => shutdown(),
      onCycleVoice: () => voiceSession?.cycleVoice(),
      onToggleMicrophone: () => voiceSession?.toggleMicrophone(),
      onToggleSpeaker: () => voiceSession?.toggleSpeaker(),
      reducedMotion: args["reduce-motion"],
    })
  : createConsoleUI()
ui.setStatus({ server: endpoint.url, model: `${args["coding-model"]}:${args.variant}` })
ui.meta(`opencode ${endpoint.url} (version ${health.version})`)
ui.meta(`project ${args.directory}`)
ui.meta(`trace ${trace.path}`)
trace.write("voice.started", {
  backend: protocol.name,
  model,
  directory: args.directory,
  duplex: args.duplex,
  speakers: args.speakers,
})

const voices = ["marin", "cedar", "coral", "sage", "ash", "ballad", "alloy", "verse"]
const pendingNotifications: OpenCodeAnnouncement[] = []
const { createOpenCodeBridge } = await import("./opencode")
const opencode = await createOpenCodeBridge({
  client,
  directory: args.directory,
  model: { providerID: args.provider, id: args["coding-model"], variant: args.variant },
  notify: (announcement) => {
    if (voiceSession) return voiceSession.queueNotification(announcement)
    pendingNotifications.push(announcement)
  },
  trace: (event, data) => trace.write(event, data),
}).catch(async (error) => {
  ui.close()
  await trace.close()
  console.error(`Voice startup failed: ${String(error)}`)
  process.exit(1)
})
const toolDefinitions = [...opencode.definitions, voiceControlTool(voices)]

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
- Treat private voice-control context in controller results as silent state. Never read it aloud.
- When delegating follow-up work, include the relevant OpenCode session ID from that private context.
- Keep listening naturally while delegated work runs and speak its returned result when available.`
    : `${baseInstructions}
- Use find_projects for explicit cross-project work. Never invent project IDs or expose filesystem paths.
- Use find_sessions to resolve references such as "the audio session". Search the current project first unless the user asks across projects.
- Use read_session to inspect a discovered Session directly. Do not prompt a Session merely to read its existing output.
- Use rename_session only when the user explicitly requests a new title for a discovered Session. Confirm the resulting title without reading its ID aloud.
- Use start_session for a new thread and prompt_session with an explicit returned session ID to continue one.
- Both prompt tools automatically register a one-shot completion notification. Never wait or poll for completion.
- Before interrupt_session, state what will stop and obtain explicit confirmation.
- Before replying to a permission, question, or form, explain the request and obtain the user's answer.`

const delegationInstructions = `You are the OpenCode controller behind a live voice assistant.
Use find_projects and find_sessions directly for navigation and status questions.
Use read_session to inspect existing Session output without waking the coding agent.
Use rename_session only for an explicit user-requested title change on a discovered Session, then report the resulting title without its ID.
Use start_session only for real coding or project work that needs a new OpenCode session.
Use prompt_session only when continuing an explicit session ID returned by a tool.
Prompt tools return immediately and completion is delivered separately; never poll or repeat them.
Return concise factual text for the live assistant to summarize.`
const controllerContext = createResponsesControllerContext()
let controllerQueue = Promise.resolve()

const delegate = (request: { readonly text: string }, execute: Parameters<typeof runResponsesController>[0]["execute"]) => {
  const result = controllerQueue.then(() =>
    runResponsesController({
      apiKey,
      model: args["delegation-model"],
      instructions: delegationInstructions,
      text: request.text,
      tools: responsesControllerTools(opencode.definitions, request.text, controllerContext),
      execute,
      context: controllerContext,
      trace: (event, data) => trace.write(event, data),
    }),
  )
  controllerQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

audioSession = args.text
  ? undefined
  : await createAudioSession({
      duplex: args.duplex,
      speakers: args.speakers,
      inputActivity: protocol.inputActivity,
      debug: args.debug,
      trace: (event, data) => trace.write(event, data),
    })
const fullDuplex = audioSession?.fullDuplex ?? false

voiceSession = createVoiceSession({
  protocol,
  connection: {
    apiKey,
    model,
    instructions,
    tools: toolDefinitions,
    fullDuplex,
    debug: args.debug,
    trace: (event, data) => trace.write(event, data),
  },
  initialVoice: args.voice ?? "marin",
  voices,
  text: args.text,
  ui,
  audio: audioSession,
  tools: {
    execute: opencode.execute,
    acknowledge: opencode.acknowledge,
    close: opencode.close,
  },
  delegate,
  trace: (event, data) => trace.write(event, data),
  onClosed: shutdown,
})
pendingNotifications.forEach((announcement) => voiceSession?.queueNotification(announcement))

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
  trace.write("voice.shutdown")
  void Promise.race([
    voiceSession?.close() ?? Promise.resolve(),
    Bun.sleep(5_000).then(() => trace.write("voice.shutdown.timeout")),
  ])
    .then(() => trace.close())
    .finally(finishShutdown)
}

// A surviving process keeps the microphone hot and the OpenAI meter running,
// so every terminal-death signal must tear it down.
process.on("SIGINT", shutdown)
process.on("SIGHUP", shutdown)
process.on("SIGTERM", shutdown)

voiceSession.start()
