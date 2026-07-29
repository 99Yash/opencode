export type PromptHandle = {
  readonly sessionID: string
  readonly promptID: string
}

export function promptKey(handle: PromptHandle) {
  return `${handle.sessionID}:${handle.promptID}`
}
