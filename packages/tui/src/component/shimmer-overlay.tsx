import { OptimizedBuffer, Renderable, RGBA, type RenderableOptions, type RenderContext } from "@opentui/core"
import { extend } from "@opentui/solid"
import { For, Show } from "solid-js"

export type ShimmerParams = {
  enabled: number
  strength: number
  band: number
  fold: number
  duration: number
  red: number
  green: number
  blue: number
}

export const SHIMMER_DEFAULTS: ShimmerParams = {
  enabled: 1,
  strength: 0.08,
  band: 8,
  fold: 0.08,
  duration: 600,
  red: 150,
  green: 190,
  blue: 255,
}

export const SHIMMER_CONTROLS: {
  key: keyof ShimmerParams
  label: string
  min: number
  max: number
  step: number
  digits: number
}[] = [
  { key: "enabled", label: "Enabled", min: 0, max: 1, step: 1, digits: 0 },
  { key: "strength", label: "Strength", min: 0, max: 0.5, step: 0.01, digits: 2 },
  { key: "band", label: "Band", min: 2, max: 24, step: 1, digits: 0 },
  { key: "fold", label: "Fold", min: 0, max: 0.3, step: 0.01, digits: 2 },
  { key: "duration", label: "Duration", min: 200, max: 1500, step: 50, digits: 0 },
  { key: "red", label: "Red", min: 0, max: 255, step: 5, digits: 0 },
  { key: "green", label: "Green", min: 0, max: 255, step: 5, digits: 0 },
  { key: "blue", label: "Blue", min: 0, max: 255, step: 5, digits: 0 },
]

// Annotation-mode overlay drawn directly into the frame buffer: one renderable, no per-cell
// layout nodes or signals. Steady state is a constant very-low-opacity tint across the whole
// app. Enabling it plays an entrance: the tint rolls diagonally onto the screen from the
// top-left like a sheet settling over the UI, its leading edge a soft band that dissolves
// into nothing, optionally with a faint brighter "fold" line riding the curl. Disabling is
// instant. Once settled the renderable stops driving frames and just paints the flat tint
// whenever the app renders anyway.
export class ShimmerOverlayRenderable extends Renderable {
  private elapsed = 0
  private params: ShimmerParams = { ...SHIMMER_DEFAULTS }
  private scratch = RGBA.fromInts(SHIMMER_DEFAULTS.red, SHIMMER_DEFAULTS.green, SHIMMER_DEFAULTS.blue, 0)

  constructor(ctx: RenderContext, options: RenderableOptions<ShimmerOverlayRenderable>) {
    super(ctx, { ...options, live: SHIMMER_DEFAULTS.enabled >= 0.5 })
  }

  setParams(value: ShimmerParams) {
    const wasEnabled = this.params.enabled >= 0.5
    const enabled = value.enabled >= 0.5
    this.params = value
    this.scratch = RGBA.fromInts(value.red, value.green, value.blue, 0)
    // Re-enabling replays the entrance roll; disabling is instant.
    if (enabled && !wasEnabled) {
      this.elapsed = 0
      this.live = true
    }
    if (!enabled) this.live = false
    this.requestRender()
  }

  protected override onUpdate(deltaTime: number): void {
    if (!this.live) return
    this.elapsed += deltaTime
    // Settled: stop driving frames; renderSelf keeps painting the flat tint on normal renders.
    if (this.elapsed >= this.params.duration) this.live = false
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const p = this.params
    if (p.enabled < 0.5 || !this.visible || this.isDestroyed || this.width <= 0 || this.height <= 0) return
    const settled = this.elapsed >= p.duration
    // Settled fast path: one flat translucent sheet, no per-cell math.
    if (settled) {
      this.scratch.a = p.strength
      buffer.fillRect(this.screenX, this.screenY, this.width, this.height, this.scratch)
      return
    }
    // Diagonal roll: cells are ordered by i + 2j (rows span ~2 columns of visual space), and
    // the front sweeps that span with an ease-out so the sheet arrives fast and lands gently.
    const t = Math.min(1, this.elapsed / p.duration)
    const eased = 1 - (1 - t) * (1 - t) * (1 - t)
    const span = this.width - 1 + (this.height - 1) * 2 + p.band
    const front = eased * span
    for (let j = 0; j < this.height; j++) {
      const base = j * 2
      for (let i = 0; i < this.width; i++) {
        const behind = front - (i + base)
        if (behind <= 0) continue
        if (behind >= p.band) {
          this.scratch.a = p.strength
          buffer.fillRect(this.screenX + i, this.screenY + j, 1, 1, this.scratch)
          continue
        }
        // Inside the leading band: tint ramps smoothly into nothing toward the front, and an
        // optional brighter fold line rides the curl just behind the edge.
        const r = behind / p.band
        const ramp = r * r * (3 - 2 * r)
        const rise = Math.min(1, r / 0.25)
        const fall = Math.max(0, 1 - (r - 0.25) / 0.75)
        const bump = rise * rise * (3 - 2 * rise) * fall * fall
        const alpha = ramp * p.strength + bump * p.fold
        if (alpha < 0.004) continue
        this.scratch.a = alpha > 1 ? 1 : alpha
        buffer.fillRect(this.screenX + i, this.screenY + j, 1, 1, this.scratch)
      }
    }
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    shimmer_overlay: typeof ShimmerOverlayRenderable
  }
}

extend({ shimmer_overlay: ShimmerOverlayRenderable })

export function ShimmerOverlay(props: {
  width: number
  height: number
  ref?: (renderable: ShimmerOverlayRenderable) => void
}) {
  return (
    <shimmer_overlay
      ref={props.ref}
      position="absolute"
      left={0}
      top={0}
      width={props.width}
      height={props.height}
      zIndex={900}
    />
  )
}

const BAR_WIDTH = 12

function formatRow(control: (typeof SHIMMER_CONTROLS)[number], value: number, selected: boolean) {
  const filled = Math.round(((value - control.min) / (control.max - control.min)) * BAR_WIDTH)
  const bar = "█".repeat(Math.max(0, Math.min(BAR_WIDTH, filled))).padEnd(BAR_WIDTH, "·")
  const display = control.key === "enabled" ? (value >= 0.5 ? "on" : "off") : value.toFixed(control.digits)
  return `${selected ? "▸ " : "  "}${control.label.padEnd(10)}${bar} ${display}`
}

export function ShimmerTuner(props: { open: boolean; selected: number; params: ShimmerParams }) {
  return (
    <Show when={props.open}>
      <box
        position="absolute"
        top={1}
        left={2}
        zIndex={1100}
        flexDirection="column"
        backgroundColor={RGBA.fromInts(16, 20, 30, 235)}
        border
        borderColor={RGBA.fromInts(90, 130, 200)}
        title="annotation overlay"
        paddingLeft={1}
        paddingRight={1}
      >
        <For each={SHIMMER_CONTROLS}>
          {(control, index) => (
            <text
              fg={index() === props.selected ? RGBA.fromInts(255, 255, 255) : RGBA.fromInts(150, 160, 180)}
              content={formatRow(control, props.params[control.key], index() === props.selected)}
            />
          )}
        </For>
        <text fg={RGBA.fromInts(110, 120, 145)} content="↑↓ select  ←→ adjust  shift ×5  esc close" />
      </box>
    </Show>
  )
}
