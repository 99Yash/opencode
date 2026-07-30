import type { OpenCodeClient } from "@opencode-ai/client"

export function undoMessage(
  client: OpenCodeClient,
  input: { readonly sessionID: string; readonly messageID: string; readonly pending: boolean },
) {
  const revert = () => client.session.revert.stage(input).then(() => undefined)
  if (!input.pending) return revert()
  return client.session.pending
    .withdraw({ sessionID: input.sessionID, inputID: input.messageID })
    .then((withdrawn) => (withdrawn ? undefined : revert()))
}
