const toolDisplays = new Set([
  "shell",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "subagent",
  "execute",
  "patch",
  "question",
  "skill",
])

export function toolDisplay(tool: string) {
  // Legacy transcripts recorded the shell tool as "bash" and the subagent tool as "task"; render
  // them with the renamed views.
  const normalized = tool === "bash" ? "shell" : tool === "task" ? "subagent" : tool === "apply_patch" ? "patch" : tool
  return toolDisplays.has(normalized) ? normalized : "generic"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}
