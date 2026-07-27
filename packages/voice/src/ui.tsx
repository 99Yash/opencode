/** @jsxImportSource @opentui/solid */
// Terminal UI for the voice spike. The TUI keeps conversation order stable
// even though realtime events arrive out of order: a user row is inserted the
// moment the audio buffer commits (before the assistant starts replying) and
// its transcript is filled in when Whisper finishes.
import { createCliRenderer, RGBA } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { registerSpinner } from "opentui-spinner/solid"
import { createSignal, For } from "solid-js"

registerSpinner()

export type VoiceStatus = {
  server?: string
  session?: string
  audio?: string
  voice?: string
  model?: string
  project?: string
}

export type VoiceUI = {
  meta(text: string): void
  userSpeaking(active: boolean): void
  userAudioLevel(level?: number): void
  userCommitted(itemID: string): void
  userTranscript(itemID: string, text: string): void
  assistantAudio(level: number, durationMs: number): void
  assistantDelta(text: string): void
  assistantDone(): void
  toolStart(callID: string, name: string, input: unknown): void
  toolDone(callID: string, output: unknown): void
  setStatus(patch: VoiceStatus): void
  close(): void
}

type Message =
  | { kind: "user"; itemID: string; text?: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; callID: string; name: string; input: unknown; output?: unknown }
  | { kind: "meta"; text: string }

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text)

const displayJson = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === "string" ? truncate(item, 500) : item), 2) ?? "null"

function toolSummary(name: string, output?: unknown) {
  if (output === undefined) return "running"
  if (Array.isArray(output)) return `${output.length} result${output.length === 1 ? "" : "s"}`
  if (!output || typeof output !== "object") return String(output)
  const value = output as Record<string, unknown>
  if (name === "wait_for_reply")
    return `${String(value["status"] ?? "done")} · ${typeof value["text"] === "string" ? `${value["text"].length} chars` : "no reply"}`
  if (name === "prompt_session")
    return `${value["admitted"] ? "admitted" : "rejected"} · ${String(value["sessionID"] ?? "unknown session")}`
  if (name === "check_session") {
    const tools = Array.isArray(value["runningTools"]) ? ` · ${value["runningTools"].join(", ")}` : ""
    return `${String(value["status"] ?? "checked")}${tools}`
  }
  if (name === "create_session" || name === "select_session")
    return `${name === "create_session" ? "created" : "selected"} · ${String(value["sessionID"] ?? "unknown session")}`
  if (name === "interrupt_session") return value["interrupted"] ? "interrupted" : "not interrupted"
  if (name === "set_voice") return `switching to ${String(value["voice"] ?? "unknown")}`
  const fields = Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 2)
    .map(([key, item]) => `${key}: ${String(item)}`)
  return fields.join(" · ") || "completed"
}

// ---------------------------------------------------------------------------
// Console fallback (--text mode, non-TTY)
// ---------------------------------------------------------------------------

export function createConsoleUI(): VoiceUI {
  const tty = process.stdout.isTTY
  const dim = (text: string) => (tty ? `\x1b[2m${text}\x1b[0m` : text)
  const cyan = (text: string) => (tty ? `\x1b[1;36m${text}\x1b[0m` : text)
  const green = (text: string) => (tty ? `\x1b[1;32m${text}\x1b[0m` : text)

  let streaming = false
  const tools = new Map<string, string>()
  const line = (text: string) => {
    if (streaming) {
      process.stdout.write("\n")
      streaming = false
    }
    console.log(text)
  }

  return {
    meta: (text) => line(dim(`  ${text}`)),
    userSpeaking: () => {},
    userAudioLevel: () => {},
    userCommitted: () => {},
    userTranscript: (_, text) => line(cyan("● you ") + text),
    assistantAudio: () => {},
    assistantDelta: (text) => {
      if (!streaming) {
        process.stdout.write(green("● assistant "))
        streaming = true
      }
      process.stdout.write(text)
    },
    assistantDone: () => {
      if (streaming) process.stdout.write("\n")
      streaming = false
    },
    toolStart: (callID, name) => {
      tools.set(callID, name)
      line(dim(`  ◌ ${name}  running`))
    },
    toolDone: (callID, output) => {
      const name = tools.get(callID) ?? "tool"
      tools.delete(callID)
      line(dim(`  ✓ ${name}  ${toolSummary(name, output)}`))
    },
    setStatus: () => {},
    close: () => {},
  }
}

// ---------------------------------------------------------------------------
// OpenTUI
// ---------------------------------------------------------------------------

const theme = {
  text: "#c0caf5",
  muted: "#565f89",
  you: "#7dcfff",
  assistant: "#9ece6a",
  key: "#7aa2f7",
  string: "#9ece6a",
  number: "#e0af68",
  literal: "#bb9af7",
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const colors = {
  text: RGBA.fromHex(theme.text),
  you: RGBA.fromHex(theme.you),
  assistant: RGBA.fromHex(theme.assistant),
}
const AUDIO_FRAME_MS = 33
const AUDIO_LEVEL_STALE_MS = 250
const meterGlyphs = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

function fade(color: RGBA, opacity: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * opacity)
}

function meter(level: number, phase: number) {
  return [0, 1, 2, 3]
    .map((index) => {
      const value = Math.max(0, Math.min(1, level * (0.72 + Math.sin(phase + index * 1.4) * 0.28)))
      return meterGlyphs[Math.round(value * (meterGlyphs.length - 1))]
    })
    .join("")
}

// Tiny JSON tokenizer for syntax-highlighted tool results.
function jsonTokens(json: string) {
  const tokens: Array<{ text: string; color: string }> = []
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:]+|\s+)/g
  for (const match of json.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], color: match[2] ? theme.key : theme.string })
      if (match[2]) tokens.push({ text: match[2], color: theme.muted })
      continue
    }
    if (match[3] !== undefined) {
      tokens.push({ text: match[3], color: theme.number })
      continue
    }
    if (match[4] !== undefined) {
      tokens.push({ text: match[4], color: theme.literal })
      continue
    }
    tokens.push({ text: match[5] ?? "", color: theme.muted })
  }
  return tokens
}

// `kind` never changes after creation, so branching once here is safe; the
// property reads inside JSX stay reactive through the store proxy.
function MessageRow(props: { message: Message; details: boolean; assistantLevel: () => number; animate: boolean }) {
  const message = props.message
  if (message.kind === "user")
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        border={["left"]}
        borderColor={fade(colors.you, 0.38)}
        backgroundColor={fade(colors.you, 0.035)}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <text fg={fade(colors.you, 0.72)}>
          <b>you</b>
          {"  "}
          <span style={{ fg: fade(colors.text, 0.74) }}>{message.text ?? "transcribing"}</span>
        </text>
      </box>
    )
  if (message.kind === "assistant") {
    const pulse = () => (!props.animate || !message.streaming ? 0.5 : props.assistantLevel())
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        border={["left"]}
        borderColor={fade(colors.assistant, message.streaming ? 0.58 + pulse() * 0.42 : 0.3)}
        backgroundColor={fade(colors.assistant, message.streaming ? 0.055 + pulse() * 0.11 : 0.025)}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <text fg={fade(colors.assistant, message.streaming ? 0.82 + pulse() * 0.18 : 0.58)}>
          <b>assistant</b>
          {"  "}
          <span style={{ fg: fade(colors.text, message.streaming ? 1 : 0.7) }}>{message.text}</span>
        </text>
      </box>
    )
  }
  if (message.kind === "tool")
    return (
      <box flexDirection="column" paddingLeft={2}>
        <box flexDirection="row" gap={1}>
          {message.output === undefined ? (
            props.animate ? (
              <spinner frames={SPINNER_FRAMES} interval={80} color={theme.number} />
            ) : (
              <text fg={theme.number}>⋯</text>
            )
          ) : (
            <text fg={theme.assistant}>✓</text>
          )}
          <text fg={theme.muted}>
            <span style={{ fg: theme.key }}>{message.name}</span>
            {"  "}
            {toolSummary(message.name, message.output)}
          </text>
        </box>
        {props.details ? (
          <text fg={theme.muted} paddingLeft={2}>
            <For each={jsonTokens(displayJson({ input: message.input, output: message.output }))}>
              {(token) => <span style={{ fg: token.color }}>{token.text}</span>}
            </For>
          </text>
        ) : null}
      </box>
    )
  return (
    <text fg={theme.muted} paddingLeft={2}>
      · {message.text}
    </text>
  )
}

function UserSpeakingBubble(props: { level: () => number | undefined; now: () => number; animate: boolean }) {
  const pulse = () => (!props.animate ? 0.5 : (props.level() ?? 0.65))
  const activity = () => {
    if (!props.animate) return "voice"
    return meter(Math.max(0.18, props.level() ?? 0.65), props.now() / (props.level() === undefined ? 220 : 320))
  }
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["left"]}
      borderColor={fade(colors.you, 0.58 + pulse() * 0.42)}
      backgroundColor={fade(colors.you, 0.055 + pulse() * 0.11)}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      <text fg={fade(colors.you, 0.82 + pulse() * 0.18)}>
        <b>you</b>
        {"  "}
        <span style={{ fg: fade(colors.text, 0.8) }}>{activity()}</span>
      </text>
    </box>
  )
}

export async function createVoiceTUI(options: {
  onInterrupt(): void
  onExit(): void
  onCycleVoice(): void
  reducedMotion?: boolean
}): Promise<VoiceUI> {
  const [state, setState] = createSignal({
    messages: [] as Message[],
    status: {} as VoiceStatus,
    details: false,
  })
  const [animationFrame, setAnimationFrame] = createSignal(performance.now())
  const [userActive, setUserActive] = createSignal(false)
  let animationTimer: ReturnType<typeof setInterval> | undefined
  let assistantSegments: Array<{ start: number; end: number; level: number }> = []
  let assistantScheduledUntil = 0
  let assistantLevel = 0
  let userTargetLevel = 0
  let userLevel = 0
  let userLevelAt = 0

  const renderer = await createCliRenderer({
    useMouse: true,
    // Handle Ctrl-C in OpenTUI's native input parser, before Solid handlers
    // and rendering work. onDestroy performs process/audio cleanup below.
    exitOnCtrlC: true,
    exitSignals: [],
    autoFocus: false,
    openConsoleOnError: false,
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    onDestroy: () => {
      if (animationTimer) clearInterval(animationTimer)
      options.onExit()
    },
  })

  const startAnimation = () => {
    if (options.reducedMotion) return renderer.requestRender()
    if (animationTimer) return
    animationTimer = setInterval(() => {
      const now = performance.now()
      assistantSegments = assistantSegments.filter((segment) => segment.end > now)
      const output = assistantSegments.find((segment) => segment.start <= now)
      const assistantTarget = output?.level ?? 0
      const userTarget = now - userLevelAt < AUDIO_LEVEL_STALE_MS ? userTargetLevel : 0
      assistantLevel += (assistantTarget - assistantLevel) * (assistantTarget > assistantLevel ? 0.5 : 0.16)
      userLevel += (userTarget - userLevel) * (userTarget > userLevel ? 0.5 : 0.18)
      setAnimationFrame(now)
      renderer.requestRender()
      if (userActive() || assistantSegments.length > 0 || assistantLevel > 0.01 || userLevel > 0.01) return
      clearInterval(animationTimer)
      animationTimer = undefined
    }, AUDIO_FRAME_MS)
  }

  const currentAssistantLevel = () => {
    animationFrame()
    return assistantLevel
  }
  const currentUserLevel = () => {
    const now = animationFrame()
    if (now - userLevelAt >= AUDIO_LEVEL_STALE_MS) return undefined
    return userLevel
  }

  function App() {
    const dimensions = useTerminalDimensions()
    useKeyboard((evt) => {
      if (evt.ctrl && evt.name === "c") return
      if (evt.name === "v") return options.onCycleVoice()
      if (evt.name === "d") {
        setState((current) => ({ ...current, details: !current.details }))
        renderer.requestRender()
        return
      }
      options.onInterrupt()
    })
    const statusLine = () =>
      [
        state().status.audio ?? "connecting…",
        state().status.voice,
        state().status.model,
        state().status.project,
        state().status.session ?? "no session",
        state().status.server,
        `v: voice · d: details ${state().details ? "on" : "off"} · any key interrupts · ctrl+c quits`,
      ]
        .filter(Boolean)
        .join("   ")
    return (
      <box
        flexDirection="column"
        width={dimensions().width}
        height={dimensions().height}
        paddingLeft={1}
        paddingRight={1}
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
          <box flexDirection="column" flexShrink={0}>
            <For each={state().messages}>
              {(message) => (
                <MessageRow
                  message={message}
                  details={state().details}
                  assistantLevel={currentAssistantLevel}
                  animate={!options.reducedMotion}
                />
              )}
            </For>
            {userActive() ? (
              <UserSpeakingBubble level={currentUserLevel} now={animationFrame} animate={!options.reducedMotion} />
            ) : null}
          </box>
        </scrollbox>
        <box height={1} marginTop={1}>
          <text fg={theme.muted}>{statusLine()}</text>
        </box>
      </box>
    )
  }

  void render(() => <App />, renderer)

  const redraw = () => renderer.requestRender()
  const push = (message: Message) => {
    setState((current) => ({ ...current, messages: [...current.messages, message] }))
    redraw()
  }

  return {
    meta: (text) => push({ kind: "meta", text }),
    userSpeaking: (active) => {
      setUserActive(active)
      if (active) startAnimation()
      if (!active) userTargetLevel = 0
      redraw()
    },
    userAudioLevel: (level) => {
      if (level === undefined) {
        userLevelAt = 0
        return
      }
      userTargetLevel = Math.max(0, Math.min(1, level))
      userLevelAt = performance.now()
      if (userActive()) startAnimation()
    },
    userCommitted: (itemID) => {
      setUserActive(false)
      push({ kind: "user", itemID })
    },
    userTranscript: (itemID, text) => {
      const index = state().messages.findIndex((m) => m.kind === "user" && m.itemID === itemID)
      if (index === -1) return push({ kind: "user", itemID, text })
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "user" ? { ...message, text } : message,
        ),
      }))
      redraw()
    },
    assistantAudio: (level, durationMs) => {
      if (options.reducedMotion) return redraw()
      const now = performance.now()
      const start = Math.max(now, assistantScheduledUntil)
      const end = start + durationMs
      assistantSegments.push({ start, end, level: Math.max(0, Math.min(1, level)) })
      assistantScheduledUntil = end
      startAnimation()
    },
    assistantDelta: (text) => {
      const index = state().messages.length - 1
      const last = state().messages[index]
      if (last?.kind === "assistant" && last.streaming) {
        setState((current) => ({
          ...current,
          messages: current.messages.map((message, i) =>
            i === index && message.kind === "assistant" ? { ...message, text: message.text + text } : message,
          ),
        }))
        redraw()
        return
      }
      setState((current) => ({
        ...current,
        messages: [
          ...current.messages.map((message) =>
            message.kind === "assistant" && message.streaming ? { ...message, streaming: false } : message,
          ),
          { kind: "assistant", text, streaming: true },
        ],
      }))
      redraw()
    },
    assistantDone: () => {
      assistantSegments = []
      assistantScheduledUntil = 0
      assistantLevel = 0
      const index = state().messages.findLastIndex((message) => message.kind === "assistant" && message.streaming)
      if (index === -1) return
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "assistant" ? { ...message, streaming: false } : message,
        ),
      }))
      redraw()
    },
    toolStart: (callID, name, input) => push({ kind: "tool", callID, name, input }),
    toolDone: (callID, output) => {
      const index = state().messages.findIndex((message) => message.kind === "tool" && message.callID === callID)
      if (index === -1) return
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "tool" ? { ...message, output } : message,
        ),
      }))
      redraw()
    },
    setStatus: (patch) => {
      setState((current) => ({ ...current, status: { ...current.status, ...patch } }))
      redraw()
    },
    close: () => {
      if (!renderer.isDestroyed) renderer.destroy()
    },
  }
}
