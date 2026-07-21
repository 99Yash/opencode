import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { DevTools } from "../devtools"

const sampleInterval = 1_000
const eventLoopInterval = 100

export function PerformanceDevTools() {
  const renderer = useRenderer()
  const runtime = DevTools.register({ id: "runtime-performance", title: "Runtime performance" })
  const rendering = DevTools.register({ id: "renderer-performance", title: "Renderer performance" })
  let previousTime = performance.now()
  let previousCpu = process.cpuUsage()
  let eventLoopTime = previousTime
  let eventLoopLag = 0

  renderer.resetStats()
  renderer.setGatherStats(true)

  const eventLoopTimer = setInterval(() => {
    const now = performance.now()
    eventLoopLag = Math.max(eventLoopLag, now - eventLoopTime - eventLoopInterval)
    eventLoopTime = now
  }, eventLoopInterval)

  const sample = setInterval(() => {
    const now = performance.now()
    const cpu = process.cpuUsage()
    const elapsed = now - previousTime
    const memory = process.memoryUsage()
    const stats = renderer.getStats()
    const scheduler = renderer.getSchedulerState()
    const frameTimes = stats.frameTimes.toSorted((left, right) => left - right)
    const frameP95 = frameTimes[Math.ceil(frameTimes.length * 0.95) - 1]

    runtime.setAll([
      {
        key: "TUI CPU",
        value: `${(((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsed * 1_000)) * 100).toFixed(1)}%`,
      },
      { key: "Event loop max", value: `${Math.max(0, eventLoopLag).toFixed(1)} ms` },
      { key: "RSS", value: megabytes(memory.rss) },
      { key: "Heap used", value: megabytes(memory.heapUsed) },
      { key: "Array buffers", value: megabytes(memory.arrayBuffers) },
    ])
    rendering.setAll([
      { key: "FPS", value: stats.fps },
      { key: "Frame p95", value: milliseconds(frameP95) },
      { key: "Frame max", value: milliseconds(stats.maxFrameTime || undefined) },
      { key: "Native render", value: microseconds(stats.nativeRenderTime) },
      { key: "Terminal write", value: microseconds(stats.nativeStdoutWriteTime) },
      { key: "Frame callbacks", value: milliseconds(stats.frameCallbackTime) },
      { key: "Cells updated", value: stats.cellsUpdated },
      { key: "Cells average", value: stats.averageCellsUpdated },
      { key: "Target FPS", value: renderer.targetFps },
      {
        key: "Scheduler",
        value: scheduler.isRendering
          ? "rendering"
          : scheduler.hasScheduledRender
            ? "scheduled"
            : scheduler.isRunning
              ? "live"
              : "idle",
      },
      { key: "Terminal", value: `${renderer.width} x ${renderer.height}` },
    ])

    previousTime = now
    previousCpu = cpu
    eventLoopLag = 0
  }, sampleInterval)

  onCleanup(() => {
    clearInterval(eventLoopTimer)
    clearInterval(sample)
    renderer.setGatherStats(false)
  })

  return null
}

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function milliseconds(value: number | undefined) {
  return value === undefined ? "n/a" : `${value.toFixed(2)} ms`
}

function microseconds(value: number | undefined) {
  return value === undefined ? "n/a" : milliseconds(value / 1_000)
}
