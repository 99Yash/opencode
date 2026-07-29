import type { CompletionReceipt, OpenCodeAnnouncement } from "./opencode-notification"
import { promptKey } from "./prompt-handle"

export type RoutedAnnouncement = {
  readonly announcement: OpenCodeAnnouncement
  readonly promptID?: string
  readonly delegationID?: string
}

export function createNotificationRouter(deliver: (announcement: RoutedAnnouncement) => void) {
  const delegations = new Map<string, string>()
  const deferred: OpenCodeAnnouncement[] = []
  let pendingDelegatedTools = 0

  const route = (announcement: OpenCodeAnnouncement) => {
    const prompt = "prompt_id" in announcement.notification
      ? { sessionID: announcement.notification.session_id, promptID: announcement.notification.prompt_id }
      : undefined
    const promptID = prompt?.promptID
    if (prompt && pendingDelegatedTools > 0 && !delegations.has(promptKey(prompt))) {
      deferred.push(announcement)
      return
    }
    deliver({
      announcement,
      promptID,
      delegationID: prompt ? delegations.get(promptKey(prompt)) : undefined,
    })
  }

  return {
    route,
    beginDelegatedTool() {
      pendingDelegatedTools += 1
    },
    finishDelegatedTool(
      delegationID: string,
      admittedPrompt?: { readonly sessionID: string; readonly promptID: string },
    ) {
      if (admittedPrompt) delegations.set(promptKey(admittedPrompt), delegationID)
      pendingDelegatedTools -= 1
      if (pendingDelegatedTools === 0) deferred.splice(0).forEach(route)
    },
    acknowledged(receipt: CompletionReceipt) {
      delegations.delete(promptKey(receipt))
    },
  }
}
