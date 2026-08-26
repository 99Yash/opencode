import { createStore } from "solid-js/store"

const [sessions, setSessions] = createStore<Record<string, boolean | undefined>>({})

export function beginWorkspaceSetup(sessionID: string, ready: Promise<void>) {
  setSessions(sessionID, true)
  void ready.then(
    () => setSessions(sessionID, undefined),
    () => setSessions(sessionID, undefined),
  )
}

export function isWorkspaceSetupPending(sessionID: string) {
  return sessions[sessionID] === true
}
