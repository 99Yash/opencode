import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { HOME_V2_SESSION_PAGE_LIMIT, loadHomeSessionIndex, parseHomeSessionIndex, retainHomeSessions } from "./index"
import { wire, type Wire } from "@/test-fixture"

const session = (id: string, input: Partial<Wire<SessionInfo>> = {}) =>
  wire<SessionInfo>({
    id,
    projectID: "project",
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/repo" },
    ...input,
  })

describe("Home session index", () => {
  test("loads all pages", async () => {
    const first = Array.from({ length: HOME_V2_SESSION_PAGE_LIMIT }, (_, index) => session(`session-${index}`))
    const calls: Array<{ cursor?: string; parentID: null }> = []
    const result = await loadHomeSessionIndex(async (input) => {
      calls.push(input)
      if (!input.cursor) return { data: first, cursor: { next: "next" } }
      return { data: [session("last")], cursor: {} }
    })

    expect(result).toHaveLength(HOME_V2_SESSION_PAGE_LIMIT + 1)
    expect(calls.map((call) => call.cursor)).toEqual([undefined, "next"])
    expect(calls.every((call) => call.parentID === null)).toBe(true)
  })

  test("keeps only visible roots", () => {
    expect(
      parseHomeSessionIndex([
        session("root"),
        session("child", { parentID: "root" }),
        session("archived", { time: { created: 1, updated: 1, archived: 2 } }),
      ]).map((item) => String(item.id)),
    ).toEqual(["root"])
  })

  test("preserves the per-directory retention limit", () => {
    const now = Date.now()
    const result = retainHomeSessions(
      [session("a", { time: { created: 1, updated: 1 } }), session("b", { time: { created: 2, updated: 2 } })],
      1,
      now,
    )
    expect(result.map((item) => String(item.id))).toEqual(["b"])
  })
})
