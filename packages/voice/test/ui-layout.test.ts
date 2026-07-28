import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

test("voice rows fill the viewport, wrap under content, and keep tools after their preamble", async () => {
  const setup = await createTestRenderer({ width: 64, height: 18, useThread: false })
  const core = await import("@opentui/core")
  void mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { createVoiceTUI } = await import("../src/ui")
  let interrupts = 0
  let voiceCycles = 0
  let microphoneToggles = 0
  let speakerToggles = 0
  const ui = await createVoiceTUI({
    onInterrupt: () => interrupts++,
    onExit: () => {},
    onCycleVoice: () => voiceCycles++,
    onToggleMicrophone: () => microphoneToggles++,
    onToggleSpeaker: () => speakerToggles++,
    reducedMotion: true,
  })

  try {
    ui.setStatus({ audio: "duplex", voice: "marin", model: "gpt-live" })
    ui.meta("[session] created session-1")
    ui.userCommitted("user-1")
    ui.userTranscript("user-1", "Please inspect the current session", true)
    ui.toolStart("tool-1", "opencode", { request: "inspect" })
    ui.meta("[session] adopted session-1")
    ui.assistantDelta("Let me check. This sentence is")
    ui.assistantDelta(" long enough to wrap cleanly under its column.")
    ui.assistantDone()
    ui.assistantDelta("Continued in the same assistant row.")
    ui.assistantDone()
    await Bun.sleep(200)
    await setup.flush()

    const rows = frameRows(setup.captureCharFrame())
    expect(rows).toHaveLength(18)
    expect(rows.every((row) => row.length === 64)).toBe(true)
    expect(rows[16]).toStartWith("  duplex   marin   gpt-live")
    expect(rows[17]).toContain("esc interrupt")
    expect(rows[17]).not.toContain("any key")
    expect(rows.filter((row) => row.includes("Let me check"))).toHaveLength(1)
    expect(rows.findIndex((row) => row.includes("opencode"))).toBeGreaterThan(
      rows.findIndex((row) => row.includes("Let me check")),
    )
    expect(rows.findIndex((row) => row.includes("[session] adopted"))).toBeGreaterThan(
      rows.findIndex((row) => row.includes("opencode")),
    )
    expect(rows.find((row) => row.includes("under its column"))?.indexOf("under")).toBe(
      rows.find((row) => row.includes("Let me check"))?.indexOf("Let"),
    )
    // Deltas inside one turn concatenate raw; a delta after assistantDone starts a new
    // message and must gain exactly one space at the boundary.
    const assistant = rows.join("")
    expect(assistant).toContain("This sentence is long enough")
    expect(assistant).toContain("column. Continued")
    expect(assistant).not.toContain("column.Continued")
    expect(rows[0]).toStartWith("   ·  [session]")

    setup.resize(96, 22)
    await setup.flush()
    const wide = frameRows(setup.captureCharFrame())
    expect(wide).toHaveLength(22)
    expect(wide.every((row) => row.length === 96)).toBe(true)
    expect(wide.at(-2)).toStartWith("  duplex   marin   gpt-live")

    setup.resize(48, 16)
    await setup.flush()
    const narrow = frameRows(setup.captureCharFrame())
    expect(narrow).toHaveLength(16)
    expect(narrow.every((row) => row.length === 48)).toBe(true)
    expect(narrow.at(-1)).toContain("esc interrupt")

    setup.resize(64, 18)
    await setup.flush()

    ui.userSpeaking(true)
    await setup.flush()
    const active = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("│ ..."))
    expect(active).toContain("│ ...")
    expect(active).not.toContain("listening")
    expect(active).not.toContain("you")

    ui.userReset()
    await setup.flush()
    expect(setup.captureCharFrame()).not.toContain("│ ...")

    ui.userSpeaking(true)
    ui.userSpeaking(false)
    ui.userCommitted("user-2")
    ui.userTranscript("user-2", "partial transcript", false)
    await setup.flush()
    const partial = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("partial transcript"))
    expect(partial).toContain("│ ... partial transcript")
    expect(partial).not.toContain("you")

    ui.userSpeaking(true)
    await setup.flush()
    expect(
      setup
        .captureCharFrame()
        .split("\n")
        .filter((row) => row.includes("│ ...")),
    ).toHaveLength(2)

    ui.userReset()
    await setup.flush()

    ui.setStatus({ microphoneMuted: true })
    await setup.flush()
    const muted = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("partial transcript"))
    expect(muted).toContain("│ partial transcript")
    expect(muted).not.toContain("│ ...")

    ui.userSpeaking(false)
    ui.setStatus({ microphoneMuted: false })
    ui.userTranscript("user-2", "partial transcript", true)
    await setup.flush()
    const complete = setup
      .captureCharFrame()
      .split("\n")
      .find((row) => row.includes("partial transcript"))
    expect(complete).toContain("│ partial transcript")

    ui.assistantDelta("First response.")
    ui.userCommitted("boundary-user")
    ui.userTranscript("boundary-user", "A new request", true)
    ui.assistantDelta("Second response.")
    await setup.flush()
    const boundaries = setup.captureCharFrame().split("\n")
    expect(boundaries.findIndex((row) => row.includes("First response."))).toBeLessThan(
      boundaries.findIndex((row) => row.includes("A new request")),
    )
    expect(boundaries.findIndex((row) => row.includes("A new request"))).toBeLessThan(
      boundaries.findIndex((row) => row.includes("Second response.")),
    )

    await setup.mockInput.typeText(" x")
    setup.mockInput.pressArrow("right")
    await setup.flush()
    expect(interrupts).toBe(0)
    expect(voiceCycles).toBe(0)
    expect(microphoneToggles).toBe(0)
    expect(speakerToggles).toBe(0)

    setup.mockInput.pressKey("v")
    setup.mockInput.pressKey("m")
    setup.mockInput.pressKey("s")
    await setup.flush()
    expect(voiceCycles).toBe(1)
    expect(microphoneToggles).toBe(1)
    expect(speakerToggles).toBe(1)

    setup.mockInput.pressEscape()
    await Bun.sleep(50)
    await setup.flush()
    expect(interrupts).toBe(1)
  } finally {
    ui.close()
    mock.restore()
  }
})

// In audio mode ui.assistantDone() is scheduled off the playback clock (spike.ts finishPlayback),
// so the next turn's transcript deltas arrive while the row is still streaming. The turn boundary
// therefore has to survive in the delta text itself, not in the row's streaming flag.
test("keeps the turn boundary when the next turn streams before playback finishes", async () => {
  const setup = await createTestRenderer({ width: 72, height: 12, useThread: false })
  const core = await import("@opentui/core")
  void mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { createVoiceTUI } = await import("../src/ui")
  const ui = await createVoiceTUI({
    onInterrupt: () => {},
    onExit: () => {},
    onCycleVoice: () => {},
    onToggleMicrophone: () => {},
    onToggleSpeaker: () => {},
    reducedMotion: true,
  })

  try {
    // Verbatim projector deltas: each turn's first fragment carries the boundary space.
    ui.assistantDelta(' Session "Fix auth bug"')
    ui.assistantDelta(" is ready.")
    // turn.done reaches the protocol, but playback is still draining, so no assistantDone() yet.
    ui.assistantDelta(" Next up, tests.")
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain('Session "Fix auth bug" is ready. Next up, tests.')
    expect(frame).not.toContain("ready.Next")
    // The row itself must not open with the boundary space.
    expect(frame).toContain('│ Session "Fix auth bug"')
    expect(frame).not.toContain('│  Session "Fix auth bug"')

    ui.assistantDone()
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("is ready. Next up, tests.")
  } finally {
    ui.close()
    mock.restore()
  }
})

test("keeps animated text mounted after its reveal completes", async () => {
  const setup = await createTestRenderer({ width: 72, height: 10, useThread: false })
  const core = await import("@opentui/core")
  void mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { createVoiceTUI } = await import("../src/ui")
  const ui = await createVoiceTUI({
    onInterrupt: () => {},
    onExit: () => {},
    onCycleVoice: () => {},
    onToggleMicrophone: () => {},
    onToggleSpeaker: () => {},
  })

  try {
    ui.assistantDelta("Animated text remains visible.")
    await Bun.sleep(500)
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Animated text remains visible.")
  } finally {
    ui.close()
    mock.restore()
  }
})

function frameRows(frame: string) {
  return frame.split("\n").slice(0, -1)
}
