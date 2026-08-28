import type { StreamCommit, TurnSummary } from "./types"

export function turnSummaryCommit(input: TurnSummary & { messageID?: string }): StreamCommit {
  return {
    kind: "system",
    text: `${input.agent} · ${input.model} · ${input.duration}`,
    phase: "final",
    source: "system",
    summary: {
      agent: input.agent,
      agentColor: input.agentColor,
      model: input.model,
      duration: input.duration,
    },
    messageID: input.messageID,
  }
}
