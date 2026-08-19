import type { StreamCommit } from "./types"
import { commandText } from "../util/command"

export function commandCommit(messageID: string | undefined, command: { name: string; arguments: string }): StreamCommit {
  return {
    kind: "system",
    source: "system",
    messageID,
    partID: "command",
    text: `→ Command "${commandText(command)}"`,
    phase: "start",
  }
}
