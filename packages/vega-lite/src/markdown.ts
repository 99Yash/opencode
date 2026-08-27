import {
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  parseColor,
  type ColorInput,
  type MarkdownCodeBlockRenderer,
  type RenderContext,
} from "@opentui/core"
import { parseChart } from "./spec"
import { renderChart } from "./render"

export type VegaLiteOptions = {
  text: ColorInput
  subdued: ColorInput
  series: readonly ColorInput[]
}

export function createVegaLiteCodeBlockRenderer(
  context: RenderContext,
  options: () => VegaLiteOptions,
): MarkdownCodeBlockRenderer {
  return (token, render) => {
    const chart = parseChart(token.text)
    if (!chart) return render.defaultRender() ?? undefined
    const palette = options()
    const text = parseColor(palette.text)
    const subdued = parseColor(palette.subdued)
    const series = palette.series.map((color) => parseColor(color))
    const plot = new TextRenderable(context, {
      width: 24,
      height: 1,
      wrapMode: "none",
      selectable: false,
      flexShrink: 0,
    })
    const viewport = new ScrollBoxRenderable(context, {
      width: "100%",
      height: 1,
      marginTop: 1,
      flexShrink: 0,
      scrollX: true,
      scrollY: false,
      onMouseScroll(event) {
        if (event.modifiers.shift || event.scroll?.direction === "left" || event.scroll?.direction === "right") {
          event.stopPropagation()
        }
      },
    })
    viewport.horizontalScrollBar.visible = false
    viewport.verticalScrollBar.visible = false
    viewport.add(plot)
    let drawnWidth = 0
    const resize = () => {
      const width = Math.max(24, Math.min(120, viewport.width || context.width))
      // Height changes also notify onSizeChange; only a new width needs another layout.
      if (width === drawnWidth) return
      drawnWidth = width
      const layout = renderChart(chart, width)
      plot.content = new StyledText(
        layout.rows.flatMap((row, index) => [
          ...row.map((cell) => ({
            __isChunk: true as const,
            text: cell.text,
            fg:
              cell.role === "axis"
                ? subdued
                : cell.role === "text"
                  ? text
                  : (series[cell.role % series.length] ?? text),
          })),
          ...(index < layout.height - 1 ? [{ __isChunk: true as const, text: "\n", fg: text }] : []),
        ]),
      )
      plot.width = layout.width
      plot.height = layout.height
      viewport.height = layout.height
    }
    viewport.onSizeChange = resize
    resize()
    return viewport
  }
}
