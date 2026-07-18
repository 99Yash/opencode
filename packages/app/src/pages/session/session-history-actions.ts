export function supportsSessionHistory(vcs?: string) {
  return vcs === "git"
}

export function sessionHistoryActions(input: {
  vcs?: string
  sessionID?: string
  hasVisibleUserMessage: boolean
  hasRevert: boolean
}) {
  const git = supportsSessionHistory(input.vcs)
  return {
    undo: git && !!input.sessionID && input.hasVisibleUserMessage,
    redo: git && !!input.sessionID && input.hasRevert,
    revert: git,
  }
}
