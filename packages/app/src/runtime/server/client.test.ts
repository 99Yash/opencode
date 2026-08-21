import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import { createRoot } from "solid-js"
import { createOpenCodeEventSource } from "./client"
import { wire } from "../../test-fixture"

const permission = wire<Extract<OpenCodeEvent, { type: "permission.asked" }>>({
  id: "evt_permission",
  created: 1,
  type: "permission.asked",
  location: { directory: "/repo", workspaceID: "workspace_1" },
  data: {
    id: "perm_1",
    sessionID: "ses_1",
    action: "read",
    resources: ["src/**"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  },
})

function setup() {
  return createRoot((dispose) => ({ ...createOpenCodeEventSource(), dispose }))
}

describe("server event stream", () => {
  test("publishes the original current event with exact data", () => {
    const server = setup()
    const received: OpenCodeEvent[] = []
    let requestID: string | undefined

    server.event.on("permission.asked", (event) => {
      requestID = event.data.id
    })
    server.event.listen((event) => received.push(event))
    server.publish(permission)

    expect(requestID).toBe("perm_1")
    expect(received).toEqual([permission])
    expect(received[0]).toBe(permission)
    server.dispose()
  })

  test("filters locations without changing workspace identity", () => {
    const server = setup()
    const repo: OpenCodeEvent[] = []
    const other: OpenCodeEvent[] = []
    const all: OpenCodeEvent[] = []
    let workspaceID: string | undefined
    const global = wire<Extract<OpenCodeEvent, { type: "server.connected" }>>({
      id: "evt_connected",
      type: "server.connected",
      data: {},
    })

    const repoEvents = server.event.location("/repo")
    repoEvents.on("permission.asked", (event) => {
      workspaceID = event.location?.workspaceID
    })
    repoEvents.listen((event) => repo.push(event))
    server.event.location("/other").listen((event) => other.push(event))
    server.event.listen((event) => all.push(event))
    server.publish(permission)
    server.publish(global)

    expect(repo).toEqual([permission])
    expect(workspaceID).toBe("workspace_1")
    expect(other).toEqual([])
    expect(all).toEqual([permission, global])
    server.dispose()
  })

  test("isolates servers and clears subscriptions with their owner", () => {
    const first = setup()
    const second = setup()
    const received = { first: 0, second: 0 }

    first.event.listen(() => received.first++)
    second.event.listen(() => received.second++)
    first.publish(permission)
    first.dispose()
    first.publish(permission)
    second.publish(permission)

    expect(received).toEqual({ first: 1, second: 1 })
    second.dispose()
  })
})
