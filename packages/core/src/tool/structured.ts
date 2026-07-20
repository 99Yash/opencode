export * as ToolStructured from "./structured"

import { ToolOutputStore } from "../tool-output-store"

export function fit<A>(project: (maxStringBytes: number) => A) {
  const full = project(ToolOutputStore.MAX_STRUCTURED_BYTES)
  if (Buffer.byteLength(JSON.stringify(full), "utf-8") <= ToolOutputStore.MAX_STRUCTURED_BYTES) return full

  let minimum = 0
  let maximum = ToolOutputStore.MAX_STRUCTURED_BYTES
  let result = project(0)
  while (minimum <= maximum) {
    const middle = Math.floor((minimum + maximum) / 2)
    const candidate = project(middle)
    if (Buffer.byteLength(JSON.stringify(candidate), "utf-8") <= ToolOutputStore.MAX_STRUCTURED_BYTES) {
      result = candidate
      minimum = middle + 1
      continue
    }
    maximum = middle - 1
  }
  return result
}

export function truncate(input: string, maximumBytes: number) {
  if (Buffer.byteLength(input, "utf-8") <= maximumBytes) return input
  const marker = " ... truncated ..."
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  const available = Math.max(0, maximumBytes - markerBytes)
  let bytes = 0
  let end = 0
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > available) break
    bytes += size
    end += char.length
  }
  return input.slice(0, end).replace(/\r?\n$/, "") + (maximumBytes >= markerBytes ? marker : "")
}
