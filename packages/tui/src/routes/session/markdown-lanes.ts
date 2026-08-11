export type MarkdownLane = {
  content: string
  width: "readable" | "code" | "wide"
}

export function markdownLanes(content: string): MarkdownLane[] {
  const result: MarkdownLane[] = []
  let fence: { marker: "`" | "~"; length: number } | undefined

  for (const line of content.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []) {
    const opening = fence ? undefined : line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/)
    const marker = opening?.[1]
    if (marker) fence = { marker: marker.startsWith("`") ? "`" : "~", length: marker.length }

    const width = opening
      ? opening[2]?.trim().split(/\s/, 1)[0]?.toLowerCase() === "mermaid"
        ? "wide"
        : "code"
      : fence
        ? (result.at(-1)?.width ?? "code")
        : "readable"
    const previous = result.at(-1)
    if (previous?.width === width) previous.content += line
    else result.push({ content: line, width })

    if (!fence) continue
    const currentFence = fence
    const trimmed = line.trim()
    if (
      !opening &&
      (line.match(/^ */)?.[0].length ?? 0) <= 3 &&
      trimmed.length >= currentFence.length &&
      [...trimmed].every((character) => character === currentFence.marker)
    ) {
      fence = undefined
    }
  }

  return result
}

export function markdownLaneMarginTop(index: number, width: MarkdownLane["width"]) {
  if (index === 0 || width === "wide") return 0
  return 1
}
