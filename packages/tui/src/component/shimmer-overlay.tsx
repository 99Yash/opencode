import {
  OptimizedBuffer,
  Renderable,
  RGBA,
  TargetChannel,
  type RenderableOptions,
  type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import { For, Show } from "solid-js"

// Clock wrap keeps phase floats small over long sessions without a visible seam.
const CLOCK_PERIOD = 3_600_000

export type ShimmerParams = {
  enabled: number
  strength: number
  keep: number
  threshold: number
  softness: number
  speed: number
  density: number
  red: number
  green: number
  blue: number
}

export const SHIMMER_DEFAULTS: ShimmerParams = {
  enabled: 0,
  strength: 0.8,
  keep: 0.25,
  threshold: 0.55,
  softness: 0.3,
  speed: 1,
  density: 1,
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
  { key: "strength", label: "Strength", min: 0, max: 1, step: 0.05, digits: 2 },
  { key: "keep", label: "Keep", min: 0, max: 1, step: 0.05, digits: 2 },
  { key: "threshold", label: "Threshold", min: 0.2, max: 0.95, step: 0.01, digits: 2 },
  { key: "softness", label: "Softness", min: 0.05, max: 1, step: 0.01, digits: 2 },
  { key: "speed", label: "Speed", min: 0, max: 3, step: 0.05, digits: 2 },
  { key: "density", label: "Density", min: 0.3, max: 3, step: 0.05, digits: 2 },
  { key: "red", label: "Red", min: 0, max: 255, step: 5, digits: 0 },
  { key: "green", label: "Green", min: 0, max: 255, step: 5, digits: 0 },
  { key: "blue", label: "Blue", min: 0, max: 255, step: 5, digits: 0 },
]

// Foreground shimmer via color matrices: instead of compositing tint boxes over the app,
// this renderable rewrites the text colors already in the frame buffer. It renders above the
// app content, so the buffer it receives holds every glyph below it; one colorMatrix call
// per frame pulls each cell's foreground toward the tint color, with per-cell strength given
// by a slowly drifting three-sine interference field. TargetChannel.FG leaves backgrounds
// untouched, so only the text shimmers. The matrix blends `keep` of the original color with
// `1 - keep` of the tint (foreground alpha is 1, so the fourth column acts as the additive
// tint term).
export class ShimmerOverlayRenderable extends Renderable {
  private clock = 0
  private params: ShimmerParams = { ...SHIMMER_DEFAULTS }
  private matrix = new Float32Array(16)
  private mask = new Float32Array(0)

  constructor(ctx: RenderContext, options: RenderableOptions<ShimmerOverlayRenderable>) {
    super(ctx, { ...options, live: SHIMMER_DEFAULTS.enabled >= 0.5 })
    this.rebuildMatrix()
  }

  setParams(value: ShimmerParams) {
    // The App unmounts the overlay while disabled (so it never blocks mouse hit-testing);
    // a stale ref may point at a destroyed instance when params change while unmounted.
    if (this.isDestroyed) return
    this.params = value
    this.rebuildMatrix()
    this.live = value.enabled >= 0.5
    this.requestRender()
  }

  private rebuildMatrix() {
    const p = this.params
    const tint = 1 - p.keep
    // Row-major 4x4: output = keep * channel + tint target (via the alpha column, since
    // foreground alpha is 1). Alpha row stays identity.
    this.matrix.fill(0)
    this.matrix[0] = p.keep
    this.matrix[3] = (p.red / 255) * tint
    this.matrix[5] = p.keep
    this.matrix[7] = (p.green / 255) * tint
    this.matrix[10] = p.keep
    this.matrix[11] = (p.blue / 255) * tint
    this.matrix[15] = 1
  }

  protected override onUpdate(deltaTime: number): void {
    if (!this.live) return
    // Speed scales the clock advance rather than the phase, so changing it never jumps.
    this.clock = (this.clock + deltaTime * this.params.speed) % CLOCK_PERIOD
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const p = this.params
    if (p.enabled < 0.5 || !this.visible || this.isDestroyed || this.width <= 0 || this.height <= 0) return
    if (p.strength <= 0) return
    if (this.mask.length < this.width * this.height * 3) this.mask = new Float32Array(this.width * this.height * 3)
    const t = this.clock / 1000
    const d = p.density
    let count = 0
    for (let j = 0; j < this.height; j++) {
      // One row spans ~2 columns of visual space; keep wave math in column units so the
      // shimmer pools read as visually round instead of vertically stretched.
      const y = j * 2
      for (let i = 0; i < this.width; i++) {
        const field =
          Math.sin((i * 0.21 + y * 0.06) * d + t * 0.5) +
          Math.sin((i * 0.114 - y * 0.083) * d - t * 0.32) +
          Math.sin((i * 0.07 + y * 0.117) * d + t * 0.21)
        const n = field / 6 + 0.5
        const v = (n - p.threshold) / p.softness
        if (v <= 0) continue
        const clamped = v >= 1 ? 1 : v
        const cell = clamped * clamped * (3 - 2 * clamped)
        if (cell < 0.02) continue
        this.mask[count] = this.screenX + i
        this.mask[count + 1] = this.screenY + j
        this.mask[count + 2] = cell
        count += 3
      }
    }
    if (count === 0) return
    buffer.colorMatrix(this.matrix, this.mask.subarray(0, count), p.strength, TargetChannel.FG)
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
        title="fg shimmer"
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
        <text fg={RGBA.fromInts(110, 120, 145)} content="ctrl+r effect  ctrl+alt+r panel" />
      </box>
    </Show>
  )
}
