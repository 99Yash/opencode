/** @jsxImportSource @opentui/solid */
// Terminal UI for the voice spike. The TUI keeps conversation order stable
// even though realtime events arrive out of order: a user row is inserted the
// moment the audio buffer commits (before the assistant starts replying) and
// its transcript is filled in when Whisper finishes.
import { createCliRenderer, RGBA } from "@opentui/core"
import { render, useKeyboard } from "@opentui/solid"
import "opentui-spinner/solid"
import { createSignal, For } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { springOpacity, transcriptionPulse, type TextReveal } from "./animation"
import { PCM_METER_FRAME_MS } from "./pcm"
import { initialVoiceView, transitionVoiceView, type Message, type VoiceViewEvent } from "./ui-model"

export { joinAssistantText } from "./ui-model"

export type VoiceStatus = {
  server?: string
  session?: string
  audio?: string
  microphoneMuted?: boolean
  speakerMuted?: boolean
  voice?: string
  model?: string
  project?: string
}

export type VoiceUI = {
  meta(text: string): void
  userSpeaking(active: boolean): void
  userReset(): void
  userAudioLevel(level?: number): void
  userCommitted(itemID: string): void
  userTranscript(itemID: string, text: string, final?: boolean): void
  assistantAudio(level: number, durationMs: number): void
  assistantPlaybackStopped(): void
  assistantDelta(text: string): void
  assistantTranscript(text: string): void
  assistantDone(): void
  toolStart(callID: string, name: string, input: unknown): void
  toolDone(callID: string, output: unknown): void
  setStatus(patch: VoiceStatus): void
  close(): void
}

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text)

const displayJson = (value: unknown) =>
  truncate(
    (() => {
      try {
        return (
          JSON.stringify(
            value,
            (_, item) =>
              typeof item === "string" ? truncate(item, 500) : typeof item === "bigint" ? String(item) : item,
            2,
          ) ?? "null"
        )
      } catch {
        return "[unserializable value]"
      }
    })(),
    8_000,
  )

function toolSummary(name: string, output?: unknown) {
  if (output === undefined) return "running"
  if (Array.isArray(output)) return `${output.length} result${output.length === 1 ? "" : "s"}`
  if (typeof output === "string") return truncate(output, 160)
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") return String(output)
  if (output === null || typeof output !== "object") return "completed"
  if ("status" in output && typeof output.status === "string")
    return output.status === "started" && "notification" in output && output.notification === "registered"
      ? "started · notification registered"
      : output.status
  const fields = Object.entries(output)
    .filter(
      ([key, item]) =>
        !key.endsWith("_id") && key !== "notification" && ["string", "number", "boolean"].includes(typeof item),
    )
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
    userReset: () => {},
    userAudioLevel: () => {},
    userCommitted: () => {},
    userTranscript: (_, text) => line(cyan("● you ") + text),
    assistantAudio: () => {},
    assistantPlaybackStopped: () => {},
    assistantDelta: (text) => {
      if (!streaming) {
        process.stdout.write(green("● assistant "))
        streaming = true
      }
      process.stdout.write(text)
    },
    assistantTranscript: (text) => line(green("● assistant ") + text),
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
const AUDIO_LEVEL_STALE_MS = 250
const TOOL_DISPLAY_DELAY_MS = 160
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
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:]+|\s+)/g
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

function RevealedText(props: {
  text: string
  reveals: ReadonlyArray<TextReveal>
  now: () => number
  opacity: () => number
}) {
  return (
    <>
      <span style={{ fg: fade(colors.text, props.opacity()) }}>
        {props.text.slice(0, props.reveals[0]?.offset ?? props.text.length)}
      </span>
      <For each={props.reveals}>
        {(reveal, index) => (
          <span style={{ fg: fade(colors.text, props.opacity() * springOpacity(props.now(), reveal.at)) }}>
            {props.text.slice(reveal.offset, props.reveals[index() + 1]?.offset ?? props.text.length)}
          </span>
        )}
      </For>
    </>
  )
}

// Message transitions preserve unchanged object identities. A changed message
// gets a new object, so keyed <For> replaces that row and this branch reruns.
function MessageRow(props: {
  message: Message
  details: boolean
  assistantLevel: () => number
  userLevel: () => number
  now: () => number
  animate: boolean
  microphoneMuted: boolean
}) {
  const message = props.message
  if (message.kind === "user") {
    const transcribing = () => message.transcribing && !props.microphoneMuted
    const pulse = () =>
      !props.animate || !transcribing() ? 0 : Math.max(props.userLevel(), transcriptionPulse(props.now()) * 0.12)
    return (
      <box
        width="100%"
        flexDirection="column"
        flexShrink={0}
        border={["left"]}
        borderColor={fade(colors.you, 0.38 + pulse() * 0.32)}
        backgroundColor={fade(colors.you, 0.035 + pulse() * 0.07)}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <box width="100%" minWidth={0} flexDirection="row">
          {transcribing() ? (
            <text width={4} flexShrink={0} fg={fade(colors.you, 0.72 + pulse() * 0.2)}>
              <b>{props.animate ? meter(Math.max(0.12, pulse()), props.now() / 240) : "..."}</b>
            </text>
          ) : null}
          <text flexGrow={1} minWidth={0} wrapMode="word">
            <RevealedText
              text={message.text ?? "transcribing"}
              reveals={message.reveals}
              now={props.now}
              opacity={() => 0.74 + pulse() * 0.2}
            />
          </text>
        </box>
      </box>
    )
  }
  if (message.kind === "assistant") {
    const pulse = () => (!props.animate || !message.streaming ? 0.5 : props.assistantLevel())
    return (
      <box
        width="100%"
        flexDirection="column"
        flexShrink={0}
        border={["left"]}
        borderColor={fade(colors.assistant, message.streaming ? 0.58 + pulse() * 0.42 : 0.3)}
        backgroundColor={fade(colors.assistant, message.streaming ? 0.055 + pulse() * 0.11 : 0.025)}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
      >
        <text width="100%" minWidth={0} wrapMode="word">
          <RevealedText
            text={message.text}
            reveals={message.reveals}
            now={props.now}
            opacity={() => (message.streaming ? 1 : 0.7)}
          />
        </text>
      </box>
    )
  }
  if (message.kind === "tool")
    return (
      <box width="100%" flexDirection="column" paddingLeft={2} marginTop={1}>
        <box width="100%" minWidth={0} flexDirection="row">
          <box width={3} flexShrink={0}>
            {message.output === undefined ? (
              props.animate ? (
                <spinner frames={SPINNER_FRAMES} interval={80} color={theme.number} />
              ) : (
                <text fg={theme.number}>⋯</text>
              )
            ) : (
              <text fg={theme.assistant}>✓</text>
            )}
          </box>
          <text flexGrow={1} minWidth={0} wrapMode="word" fg={theme.muted}>
            <span style={{ fg: theme.key }}>{message.name}</span>
            {"  "}
            {toolSummary(message.name, message.output)}
          </text>
        </box>
        {props.details ? (
          <text width="100%" minWidth={0} wrapMode="word" fg={theme.muted} paddingLeft={2}>
            <For each={jsonTokens(displayJson({ input: message.input, output: message.output }))}>
              {(token) => <span style={{ fg: token.color }}>{token.text}</span>}
            </For>
          </text>
        ) : null}
      </box>
    )
  return (
    <box width="100%" minWidth={0} flexDirection="row" paddingLeft={2}>
      <text width={3} flexShrink={0} fg={theme.muted}>
        ·
      </text>
      <text flexGrow={1} minWidth={0} wrapMode="word" fg={theme.muted}>
        {message.text}
      </text>
    </box>
  )
}

export async function createVoiceTUI(options: {
  onInterrupt(): void
  onExit(): void
  onCycleVoice(): void
  onToggleMicrophone(): void
  onToggleSpeaker(): void
  reducedMotion?: boolean
}): Promise<VoiceUI> {
  let view = initialVoiceView()
  const [messageState, setMessageState] = createStore({ items: [...view.messages] })
  const [status, setStatus] = createSignal<VoiceStatus>({})
  const [details, setDetails] = createSignal(false)
  const [animationFrame, setAnimationFrame] = createSignal(performance.now())
  let userActive = false
  let animationTimer: ReturnType<typeof setInterval> | undefined
  let assistantSegments: Array<{ start: number; end: number; level: number }> = []
  let assistantSegmentIndex = 0
  let assistantScheduledUntil = 0
  let assistantLevel = 0
  let userTargetLevel = 0
  let userLevel = 0
  let userLevelAt = 0
  const pendingTools = new Map<
    string,
    {
      name: string
      input: unknown
      output?: unknown
      completed: boolean
      showAt: number
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const pendingMetaTimers = new Set<ReturnType<typeof setTimeout>>()

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
      pendingTools.forEach((tool) => clearTimeout(tool.timer))
      pendingMetaTimers.forEach(clearTimeout)
      options.onExit()
    },
  })

  const applyView = (event: VoiceViewEvent) => {
    const next = transitionVoiceView(view, event)
    if (next === view) return false
    view = next
    setMessageState("items", reconcile([...view.messages], { key: "key" }))
    return true
  }

  const startAnimation = () => {
    if (options.reducedMotion) return
    if (animationTimer) return
    animationTimer = setInterval(() => {
      const now = performance.now()
      while (assistantSegments[assistantSegmentIndex]?.end <= now) assistantSegmentIndex += 1
      const segment = assistantSegments[assistantSegmentIndex]
      const output = segment?.start <= now ? segment : undefined
      const assistantTarget = output?.level ?? 0
      const userTarget = now - userLevelAt < AUDIO_LEVEL_STALE_MS ? userTargetLevel : 0
      assistantLevel += (assistantTarget - assistantLevel) * (assistantTarget > assistantLevel ? 0.5 : 0.16)
      userLevel += (userTarget - userLevel) * (userTarget > userLevel ? 0.5 : 0.18)
      setAnimationFrame(now)
      if (view.revealAnimationEndsAt > 0 && now >= view.revealAnimationEndsAt) applyView({ type: "reveals.completed" })
      const transcribing =
        !status().microphoneMuted &&
        messageState.items.some((message) => message.kind === "user" && message.transcribing)
      if (
        userActive ||
        transcribing ||
        now < view.revealAnimationEndsAt ||
        assistantSegmentIndex < assistantSegments.length ||
        assistantLevel > 0.01 ||
        userLevel > 0.01
      )
        return
      clearInterval(animationTimer)
      animationTimer = undefined
    }, PCM_METER_FRAME_MS)
  }

  const currentAssistantLevel = () => {
    animationFrame()
    return assistantLevel
  }
  const currentUserLevel = () => {
    animationFrame()
    return userLevel
  }

  function App() {
    useKeyboard((evt) => {
      if (evt.ctrl && evt.name === "c") return
      if (evt.repeated || evt.ctrl || evt.meta || evt.option || evt.shift) return
      if (evt.name === "v") {
        evt.preventDefault()
        return options.onCycleVoice()
      }
      if (evt.name === "m") {
        evt.preventDefault()
        return options.onToggleMicrophone()
      }
      if (evt.name === "s") {
        evt.preventDefault()
        return options.onToggleSpeaker()
      }
      if (evt.name === "d") {
        evt.preventDefault()
        setDetails((current) => !current)
        return
      }
      if (evt.name === "escape") {
        evt.preventDefault()
        options.onInterrupt()
      }
    })
    const runtimeLine = () =>
      [
        status().audio ?? "connecting…",
        status().microphoneMuted ? "mic muted" : undefined,
        status().speakerMuted ? "speaker muted" : undefined,
        status().voice,
        status().model,
        status().project,
        status().session ?? "no session",
      ]
        .filter(Boolean)
        .join("   ")
    return (
      <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
        <box width="100%" flexGrow={1} minHeight={0} minWidth={0}>
          <scrollbox width="100%" height="100%" stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
            <box width="100%" minWidth={0} flexDirection="column" flexShrink={0}>
              <For each={messageState.items}>
                {(message) => (
                  <MessageRow
                    message={message}
                    details={details()}
                    assistantLevel={currentAssistantLevel}
                    userLevel={currentUserLevel}
                    now={animationFrame}
                    animate={!options.reducedMotion}
                    microphoneMuted={status().microphoneMuted === true}
                  />
                )}
              </For>
            </box>
          </scrollbox>
        </box>
        <box width="100%" height={2} flexShrink={0} backgroundColor="#0d1018" paddingLeft={1} paddingRight={1}>
          <text width="100%" wrapMode="none" truncate fg={fade(colors.text, 0.78)}>
            {runtimeLine()}
          </text>
          <text width="100%" wrapMode="none" truncate fg={theme.muted}>
            <span style={{ fg: theme.key }}>esc</span> interrupt {"  "}
            <span style={{ fg: theme.key }}>v</span> voice {"  "}
            <span style={{ fg: theme.key }}>m</span> mic {"  "}
            <span style={{ fg: theme.key }}>s</span> speaker {"  "}
            <span style={{ fg: theme.key }}>d</span> details {details() ? "on" : "off"} {"  "}
            <span style={{ fg: theme.key }}>ctrl+c</span> quit
          </text>
        </box>
      </box>
    )
  }

  await render(() => <App />, renderer)

  const pushMeta = (text: string) => {
    if (pendingTools.size === 0) return void applyView({ type: "meta", text })
    const showAt = Math.max(...[...pendingTools.values()].map((tool) => tool.showAt))
    const timer = setTimeout(
      () => {
        pendingMetaTimers.delete(timer)
        applyView({ type: "meta", text })
      },
      Math.max(0, showAt - performance.now()) + 1,
    )
    pendingMetaTimers.add(timer)
  }

  return {
    meta: pushMeta,
    userSpeaking: (active) => {
      if (active) applyView({ type: "user.started" })
      userActive = active
      if (active) startAnimation()
      if (!active) userTargetLevel = 0
    },
    userReset: () => {
      userActive = false
      userTargetLevel = 0
      userLevel = 0
      applyView({ type: "user.reset" })
    },
    userAudioLevel: (level) => {
      if (level === undefined) {
        userLevelAt = 0
        return
      }
      userTargetLevel = Math.max(0, Math.min(1, level))
      userLevelAt = performance.now()
      if (userActive) startAnimation()
    },
    userCommitted: (itemID) => {
      userActive = false
      applyView({ type: "user.committed", itemID })
      startAnimation()
    },
    userTranscript: (itemID, text, final = true) => {
      applyView({
        type: "user.transcript",
        itemID,
        text,
        final,
        now: performance.now(),
        animate: !options.reducedMotion,
      })
      if (!final || view.revealAnimationEndsAt > 0) startAnimation()
    },
    assistantAudio: (level, durationMs) => {
      if (options.reducedMotion) return
      if (assistantSegmentIndex > 512) {
        assistantSegments = assistantSegments.slice(assistantSegmentIndex)
        assistantSegmentIndex = 0
      }
      const now = performance.now()
      const start = Math.max(now, assistantScheduledUntil)
      const end = start + durationMs
      assistantSegments.push({ start, end, level: Math.max(0, Math.min(1, level)) })
      assistantScheduledUntil = end
      startAnimation()
    },
    assistantPlaybackStopped: () => {
      assistantSegments = []
      assistantSegmentIndex = 0
      assistantScheduledUntil = 0
      assistantLevel = 0
      setAnimationFrame(performance.now())
    },
    assistantDelta: (text) => {
      applyView({
        type: "assistant.delta",
        text,
        now: performance.now(),
        animate: !options.reducedMotion,
      })
      if (view.revealAnimationEndsAt > 0) startAnimation()
    },
    assistantTranscript: (text) => {
      applyView({
        type: "assistant.transcript",
        text,
        now: performance.now(),
        animate: !options.reducedMotion,
      })
      if (view.revealAnimationEndsAt > 0) startAnimation()
    },
    assistantDone: () => {
      assistantSegments = []
      assistantSegmentIndex = 0
      assistantScheduledUntil = 0
      assistantLevel = 0
      applyView({ type: "assistant.done" })
    },
    toolStart: (callID, name, input) => {
      if (
        pendingTools.has(callID) ||
        view.messages.some((message) => message.kind === "tool" && message.callID === callID)
      )
        return
      const pending = {
        name,
        input,
        completed: false,
        showAt: performance.now() + TOOL_DISPLAY_DELAY_MS,
        timer: setTimeout(() => {
          const current = pendingTools.get(callID)
          if (!current) return
          pendingTools.delete(callID)
          applyView({
            type: "tool.started",
            callID,
            name: current.name,
            input: current.input,
          })
          if (current.completed) applyView({ type: "tool.done", callID, output: current.output })
        }, TOOL_DISPLAY_DELAY_MS),
      }
      pendingTools.set(callID, pending)
    },
    toolDone: (callID, output) => {
      const pending = pendingTools.get(callID)
      if (pending) {
        pending.output = output
        pending.completed = true
        return
      }
      applyView({ type: "tool.done", callID, output })
    },
    setStatus: (patch) => {
      setStatus((current) => ({ ...current, ...patch }))
    },
    close: () => {
      if (!renderer.isDestroyed) renderer.destroy()
    },
  }
}
