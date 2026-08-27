import { afterEach, expect, test } from "bun:test"
import {
  BoxRenderable,
  CodeRenderable,
  MarkdownRenderable,
  RGBA,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  createMarkdownCodeBlockRenderer,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createVegaLiteCodeBlockRenderer } from "./markdown"

const renderers: Awaited<ReturnType<typeof createTestRenderer>>["renderer"][] = []
const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
const spec = {
  title: "Startup time",
  data: {
    values: [
      { build: "Before", ms: 320 },
      { build: "After", ms: 120 },
      { build: "Cached", ms: 30 },
    ],
  },
  mark: "bar",
  encoding: {
    y: { field: "build", type: "nominal", sort: null },
    x: { field: "ms", type: "quantitative" },
  },
}
const source = JSON.stringify(spec)
const fence = (value = source, language = "vega-lite") => `\`\`\`${language}\n${value}\n\`\`\``

afterEach(() => {
  renderers.splice(0).forEach((renderer) => renderer.destroy())
})

async function setup(content: string, width = 80) {
  const output = await createTestRenderer({ width, height: 60, remote: true, useThread: false })
  renderers.push(output.renderer)
  const palette = { text: "#abcdef", subdued: "#667788", series: ["#44aaff", "#ffbb44"] }
  const markdown = new MarkdownRenderable(output.renderer, {
    content,
    syntaxStyle,
    streaming: true,
    internalBlockMode: "top-level",
    renderNode: createMarkdownCodeBlockRenderer({
      "vega-lite": createVegaLiteCodeBlockRenderer(output.renderer, () => palette),
    }),
  })
  const parent = new BoxRenderable(output.renderer, { width: "100%" })
  parent.add(markdown)
  output.renderer.root.add(parent)
  await output.renderOnce()
  await output.renderOnce()
  return { ...output, parent, markdown, palette }
}

test.each(["vega-lite", "VEGA-LITE", "vega-lite title=example"])("renders a %s fence", async (language) => {
  const output = await setup(fence(source, language))
  expect(output.markdown.getChildren()[0]).toBeInstanceOf(ScrollBoxRenderable)
  expect(output.captureCharFrame()).toContain("Startup time")
  expect(output.captureCharFrame()).toContain("Before")
  expect(output.captureCharFrame()).toContain("320")
  expect(output.captureCharFrame()).not.toContain('"encoding"')
})

test.each([
  "{",
  "null",
  JSON.stringify({ ...spec, transform: [{ filter: "datum.ms > 100" }] }),
  JSON.stringify({ ...spec, data: { url: "https://example.com/data.json" } }),
  JSON.stringify({ ...spec, mark: "area" }),
  JSON.stringify({ ...spec, encoding: { ...spec.encoding, x: { ...spec.encoding.x, aggregate: "mean" } } }),
])("preserves unsupported and incomplete specifications as source: %s", async (value) => {
  const output = await setup(fence(value))
  const block = output.markdown.getChildren()[0]
  expect(block).toBeInstanceOf(CodeRenderable)
  if (!(block instanceof CodeRenderable)) throw new Error("Expected source fallback")
  expect(block.content).toBe(value)
})

test("renders complete JSON during streaming and preserves the final chart", async () => {
  const output = await setup(`\`\`\`vega-lite\n${source.slice(0, -1)}`)
  expect(output.markdown.getChildren()[0]).toBeInstanceOf(CodeRenderable)
  output.markdown.content += "}"
  await output.renderOnce()
  await output.renderOnce()
  expect(output.markdown.getChildren()[0]).toBeInstanceOf(ScrollBoxRenderable)
  output.markdown.content += "\n```"
  output.markdown.streaming = false
  await output.renderOnce()
  expect(output.markdown.getChildren()[0]).toBeInstanceOf(ScrollBoxRenderable)
})

test("does not retain a stale chart for an invalid edit or leak across fences", async () => {
  const output = await setup(fence())
  output.markdown.content = `${fence(`${source}!`)}\n\n${fence("{")}`
  output.markdown.streaming = false
  await output.renderOnce()
  expect(output.markdown.getChildren().every((child) => child instanceof CodeRenderable)).toBe(true)
})

test("leaves unrelated fences alone", async () => {
  const output = await setup(fence(source, "json"))
  expect(output.markdown.getChildren()[0]).toBeInstanceOf(CodeRenderable)
})

test.each(["line", "point", "circle"])("renders %s marks with separate categorical series", async (mark) => {
  const output = await setup(
    fence(
      JSON.stringify({
        title: "Latency under load",
        data: {
          values: [
            { requests: 1, ms: 12, build: "Before" },
            { requests: 8, ms: 65, build: "Before" },
            { requests: 1, ms: 8, build: "After" },
            { requests: 8, ms: 24, build: "After" },
          ],
        },
        mark,
        encoding: {
          x: { field: "requests", type: "quantitative" },
          y: { field: "ms", type: "quantitative" },
          color: { field: "build", type: "nominal" },
        },
      }),
    ),
  )
  const plot = output.markdown.getChildren()[0]?.getChildren()[0]
  if (!(plot instanceof TextRenderable)) throw new Error("Expected chart text")
  expect(output.captureCharFrame()).toContain("Latency under load")
  expect(output.captureCharFrame()).toContain("Before")
  expect(output.captureCharFrame()).toContain("After")
  expect(output.captureCharFrame()).toMatch(/[\u2801-\u28ff]/u)
  expect(plot.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex(output.palette.series[0])))).toBe(true)
  expect(plot.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex(output.palette.series[1])))).toBe(true)
})

test("a vertical chart scrolls rather than dropping crowded categories", async () => {
  const output = await setup(
    fence(
      JSON.stringify({
        data: { values: Array.from({ length: 20 }, (_, index) => ({ build: `B${index}`, ms: index + 1 })) },
        mark: "bar",
        encoding: {
          x: { field: "build", type: "nominal", sort: null },
          y: { field: "ms", type: "quantitative" },
        },
      }),
    ),
    32,
  )
  const viewport = output.markdown.getChildren()[0]
  if (!(viewport instanceof ScrollBoxRenderable)) throw new Error("Expected chart viewport")
  expect(viewport.scrollWidth).toBeGreaterThan(32)
  expect(output.captureCharFrame()).toContain("B0")
  expect(output.captureCharFrame()).not.toContain("B19")
  viewport.scrollLeft = viewport.scrollWidth
  await output.renderOnce()
  expect(output.captureCharFrame()).toContain("B19")
})

test("reflows to the parent width without wrapping charts or surrounding prose", async () => {
  const output = await setup(`Before chart\n\n${fence()}\n\nAfter chart`)
  const viewport = output.markdown.getChildren()[1]
  if (!(viewport instanceof ScrollBoxRenderable)) throw new Error("Expected chart viewport")
  const plot = viewport.getChildren()[0]
  if (!(plot instanceof TextRenderable)) throw new Error("Expected chart text")
  const wide = plot.width
  output.parent.width = 32
  await output.renderOnce()
  await output.renderOnce()
  expect(viewport.width).toBe(32)
  expect(plot.width).toBeLessThan(wide)
  expect(plot.width).toBeLessThanOrEqual(32)
  expect(output.captureCharFrame()).toContain("Before chart")
  expect(output.captureCharFrame()).toContain("After chart")
  output.parent.width = 80
  await output.renderOnce()
  await output.renderOnce()
  expect(plot.width).toBe(wide)
})

test("keeps a minimum readable width and supports horizontal scrolling", async () => {
  const output = await setup(fence(), 18)
  const viewport = output.markdown.getChildren()[0]
  if (!(viewport instanceof ScrollBoxRenderable)) throw new Error("Expected chart viewport")
  expect(viewport.width).toBe(18)
  expect(viewport.scrollWidth).toBeGreaterThan(18)
  await output.mockMouse.scroll(2, 2, "right")
  await output.renderOnce()
  expect(viewport.scrollLeft).toBeGreaterThan(0)
})

test("uses semantic colors and refreshes after a theme change", async () => {
  const output = await setup(fence())
  const block = () => output.markdown.getChildren()[0]?.getChildren()[0]
  const plot = block()
  if (!(plot instanceof TextRenderable)) throw new Error("Expected chart text")
  expect(plot.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex(output.palette.series[0])))).toBe(true)
  expect(plot.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex(output.palette.subdued)))).toBe(true)
  expect(plot.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex(output.palette.text)))).toBe(true)
  output.palette.series[0] = "#bb33aa"
  output.palette.subdued = "#123456"
  output.markdown.refreshStyles()
  await output.renderOnce()
  await output.renderOnce()
  const updated = block()
  if (!(updated instanceof TextRenderable)) throw new Error("Expected chart text")
  expect(updated.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex("#bb33aa")))).toBe(true)
  expect(updated.chunks.some((chunk) => chunk.fg?.equals(RGBA.fromHex("#123456")))).toBe(true)
})
