export type MarkdownLane = {
  content: string
  width: "readable" | "technical" | "full"
}

export function markdownLanes(content: string): MarkdownLane[] {
  const result: MarkdownLane[] = []
  let fence: { marker: "`" | "~"; length: number } | undefined
  let table = false
  const lines = content.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []

  for (const [index, line] of lines.entries()) {
    const opening = fence ? undefined : line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)/)
    const marker = opening?.[1]
    const tableOpening = !opening && !fence && isTableRow(line) && isTableDelimiter(lines[index + 1])
    if (marker) fence = { marker: marker.startsWith("`") ? "`" : "~", length: marker.length }
    if (tableOpening) table = true

    const width = opening
      ? opening[2]?.trim().split(/\s/, 1)[0]?.toLowerCase() === "mermaid"
        ? "full"
        : "technical"
      : fence
        ? (result.at(-1)?.width ?? "technical")
        : table
          ? "technical"
          : "readable"
    const previous = result.at(-1)
    if (previous?.width === width) previous.content += line
    else result.push({ content: line, width })

    if (!fence) {
      if (table && !isTableRow(lines[index + 1])) table = false
      continue
    }
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

function isTableRow(line: string | undefined) {
  return Boolean(line?.trim() && line.includes("|"))
}

function isTableDelimiter(line: string | undefined) {
  if (!line) return false
  const value = line.trim().replace(/^\||\|$/g, "")
  const cells = value.split("|")
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

export function markdownLaneMarginTop(index: number, width: MarkdownLane["width"]) {
  if (index === 0 || width === "full") return 0
  return 1
}
