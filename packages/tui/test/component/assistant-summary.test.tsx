/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { AssistantSummary } from "../../src/component/assistant-summary"

const agent = RGBA.fromHex("#6699ff")
const subdued = RGBA.fromHex("#667085")
const text = RGBA.fromHex("#f0f2ff")

test("flashes a completed summary and settles to its semantic colors", async () => {
  const app = await testRender(
    () => (
      <AssistantSummary
        agent="Build"
        model="Simulated Model"
        duration="800ms"
        agentColor={agent}
        subduedColor={subdued}
        flashColor={text}
        animations
        flash={{ trigger: 1, duration: 0.8, intensity: 0.7 }}
      />
    ),
    { width: 60, height: 1 },
  )

  try {
    await app.renderOnce()
    const flashed = app.renderer.currentRenderBuffer.getSpanLines()[0]!.spans.filter((span) => span.text.trim())
    expect(flashed[0]!.fg.equals(agent)).toBeFalse()
    expect(flashed[1]!.fg.equals(subdued)).toBeFalse()

    await Bun.sleep(900)
    await app.renderOnce()
    const settled = app.renderer.currentRenderBuffer.getSpanLines()[0]!.spans.filter((span) => span.text.trim())
    expect(settled[0]!.fg.equals(agent)).toBeTrue()
    expect(settled[1]!.fg.equals(subdued)).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})

test("stays at rest when animations are disabled", async () => {
  const app = await testRender(
    () => (
      <AssistantSummary
        agent="Build"
        model="Simulated Model"
        agentColor={agent}
        subduedColor={subdued}
        flashColor={text}
        animations={false}
        flash={{ trigger: 1, duration: 0.8, intensity: 0.7 }}
      />
    ),
    { width: 60, height: 1 },
  )

  try {
    await app.renderOnce()
    const spans = app.renderer.currentRenderBuffer.getSpanLines()[0]!.spans.filter((span) => span.text.trim())
    expect(spans[0]!.fg.equals(agent)).toBeTrue()
    expect(spans[1]!.fg.equals(subdued)).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})
