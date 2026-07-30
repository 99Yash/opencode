import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { undoMessage } from "../../../src/routes/session/undo"

test.each([
  { withdrawn: true, expected: ["withdraw"] },
  { withdrawn: false, expected: ["withdraw", "revert"] },
])("routes undo for withdrawn=$withdrawn", async ({ withdrawn, expected }) => {
  const calls: string[] = []
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: Object.assign(
      async (input: URL | RequestInfo, init?: BunFetchRequestInit | RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const operation = request.url.endsWith("/withdraw") ? "withdraw" : "revert"
        calls.push(operation)
        return Response.json({ data: operation === "withdraw" ? withdrawn : { messageID: "msg_user" } })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  await undoMessage(client, { sessionID: "ses_test", messageID: "msg_user" })

  expect(calls).toEqual([...expected])
})
